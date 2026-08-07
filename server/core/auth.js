'use strict';
const crypto = require('node:crypto');
const { ApiError } = require('./http');
const { now } = require('./db');

const SESSION_HOURS = 12;
const LOCKOUT_FAILS = 5;        // consecutive failures before a timed lock
const LOCKOUT_MINUTES = 15;
const RATE_LIMIT_ATTEMPTS = 20; // per IP, per window, checked before any scrypt work
const RATE_LIMIT_WINDOW_MS = 60_000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

// Verified against when the username is unknown, so unknown-user and
// wrong-password logins cost the same scrypt work (no timing oracle).
const DUMMY_HASH = hashPassword('owlpos-dummy-timing-pad');

function randomCode(prefix, len) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ234569'; // no I/L/O/0/1 lookalikes
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return prefix + out;
}

// Mode + secret are resolved once per createApp (not at module load, which is
// untestable). demo (default) keeps the per-process random secret fallback;
// production fails closed: OWLPOS_SECRET must decode to >= 32 bytes of entropy.
// VERCEL never implies production — the hosted demo stays demo.
function resolveConfig(env = process.env) {
  const mode = env.OWLPOS_MODE === 'production' ? 'production' : 'demo';
  let secret = env.OWLPOS_SECRET || '';
  if (mode === 'production') {
    const isHex = /^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0;
    const bytes = isHex ? secret.length / 2 : Buffer.byteLength(secret, 'utf8');
    if (bytes < 32) {
      throw new Error('OWLPOS_SECRET (>= 32 bytes, e.g. 64 hex chars) is required in production mode');
    }
  } else if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
  }
  return { mode, secret, secure: mode === 'production' || Boolean(env.VERCEL) };
}

// Sessions are stateless signed tokens (HMAC), not DB rows: on serverless hosts
// each instance has its own SQLite file, so a DB session written by one instance
// would be invisible to the next. Set OWLPOS_SECRET in multi-instance deployments
// so every instance verifies the same signature. Revocation: each user carries a
// token_epoch; the epoch is signed into the payload and tokens whose epoch no
// longer matches the DB are dead. Format: b64url(username).epoch.exp.sig
function signToken(config, username, epoch, expEpochMs) {
  const payload = `${Buffer.from(username).toString('base64url')}.${epoch}.${expEpochMs}`;
  const sig = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseToken(config, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null; // legacy 3-part tokens fail closed
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expect = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
  const given = Buffer.from(parts[3]);
  const want = Buffer.from(expect);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  const epoch = Number(parts[1]);
  if (!Number.isInteger(epoch) || epoch < 0) return null;
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  try {
    return { username: Buffer.from(parts[0], 'base64url').toString('utf8'), epoch, exp };
  } catch {
    return null;
  }
}

function resolveUser(db, config) {
  return (req) => {
    const token = parseToken(config, req.cookies?.opsid);
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT id, username, display_name, role, must_change_password, token_epoch
         FROM users WHERE username = ? AND active = 1`
      )
      .get(token.username);
    if (!row || row.token_epoch !== token.epoch) return null;
    return row;
  };
}

// Strict same-site (all back-office calls are same-origin fetch; the guest store
// never uses opsid), Max-Age matching the token expiry, Secure in production/HTTPS.
function cookieFlags(config, maxAgeSec = SESSION_HOURS * 3600) {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.secure ? '; Secure' : ''}`;
}

function audit(db, userId, action, detail) {
  db.prepare('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(now(), userId ?? null, action, detail ? JSON.stringify(detail) : null);
}

// Shared credential check for login and manager re-auth: same lockout counters,
// same audit trail, same timing profile (dummy verify when the user is unknown
// or locked, so response timing never reveals lock state or username existence).
// Failure detail never says why — callers surface one generic error. Counter
// updates are single atomic UPDATEs (SQLite serializes writers; no JS read-
// modify-write races). Returns { ok:true, user } or { ok:false }.
function verifyCredential(db, rawUsername, rawPassword, ip) {
  const username = String(rawUsername || '').toLowerCase();
  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
    .get(username);
  if (user && user.locked_until && user.locked_until > now()) {
    verifyPassword(String(rawPassword || ''), DUMMY_HASH);
    audit(db, user.id, 'auth.login_locked', { username: user.username, ip });
    return { ok: false };
  }
  const match = verifyPassword(String(rawPassword || ''), user ? user.pass_hash : DUMMY_HASH);
  if (!user || !match) {
    if (user) {
      const lockIso = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
      db.prepare(
        `UPDATE users SET
           failed_logins = CASE WHEN failed_logins + 1 >= ? THEN 0 ELSE failed_logins + 1 END,
           locked_until  = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END
         WHERE id = ?`
      ).run(LOCKOUT_FAILS, LOCKOUT_FAILS, lockIso, user.id);
    }
    // attackers paste passwords into username fields — truncate before logging
    audit(db, user ? user.id : null, 'auth.login_failed', { username: username.slice(0, 64), ip });
    return { ok: false };
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
  return { ok: true, user };
}

// Manager re-auth for void/refund: the approver types their own credentials into
// the cashier's session. All failure modes (missing, unknown, wrong password,
// wrong role, locked) collapse into one generic 403 — this route must not be a
// password oracle, and approver attempts count against the approver's lockout.
function verifyManagerCredential(db, cred, ip) {
  const r = verifyCredential(db, cred?.username, cred?.password, ip);
  if (!r.ok || (r.user.role !== 'manager' && r.user.role !== 'admin')) {
    throw new ApiError(403, 'approval_required', 'Manager approval required');
  }
  return publicUser(r.user);
}

// Fixed-window per-IP limiter factory. Each caller gets its own closure-scoped
// bucket so parallel createApp instances (tests, serverless warm starts) never
// share state, and login vs. approver traffic can't starve each other. Pruned
// inline — no setInterval, which would keep test processes alive and is
// serverless-hostile. The returned guard runs before any scrypt work.
function createRateLimiter() {
  const attempts = new Map(); // ip -> { count, windowStart }
  return function rateLimit(req, res) {
    const ip = req.socket?.remoteAddress || 'unknown';
    const t = Date.now();
    for (const [k, v] of attempts) {
      if (t - v.windowStart >= RATE_LIMIT_WINDOW_MS) attempts.delete(k);
    }
    const slot = attempts.get(ip) || { count: 0, windowStart: t };
    slot.count++;
    attempts.set(ip, slot);
    if (slot.count > RATE_LIMIT_ATTEMPTS) {
      res.setHeader('retry-after', Math.ceil((slot.windowStart + RATE_LIMIT_WINDOW_MS - t) / 1000));
      throw new ApiError(429, 'too_many_attempts', 'Too many attempts — try again shortly');
    }
    return ip;
  };
}

function mount(router, db, config) {
  const rateLimit = createRateLimiter();

  function issueCookie(res, user) {
    const token = signToken(
      config, user.username, user.token_epoch, Date.now() + SESSION_HOURS * 3600_000
    );
    res.setHeader('set-cookie', `opsid=${token}; ${cookieFlags(config)}`);
  }

  router.post('/api/auth/login', null, (req, res) => {
    const ip = rateLimit(req, res); // before any DB lookup or scrypt work
    const { username, password } = req.body || {};
    const r = verifyCredential(db, username, password, ip);
    if (!r.ok) {
      // one generic body for unknown user / wrong password / locked account
      throw new ApiError(401, 'bad_credentials', 'Wrong username or password');
    }
    audit(db, r.user.id, 'auth.login', { username: r.user.username });
    issueCookie(res, r.user);
    return { user: publicUser(r.user), must_change_password: Boolean(r.user.must_change_password) };
  });

  router.post('/api/auth/logout', [], (req, res) => {
    res.setHeader('set-cookie', `opsid=; ${cookieFlags(config, 0)}`);
    return { ok: true };
  });

  router.get('/api/auth/me', [], (req) => ({
    user: publicUser(req.user),
    must_change_password: Boolean(req.user.must_change_password),
  }));

  // The only mutating route allowed while must_change_password = 1 (see the
  // router guard in main.js). The current-password check shares the login
  // limiter and lockout counters — a stolen session cookie must not become an
  // unthrottled password oracle. Bumps token_epoch — revoking every other
  // session — and re-issues the caller's cookie at the new epoch in the same
  // response.
  router.post('/api/auth/change-password', [], (req, res) => {
    const ip = rateLimit(req, res); // before any DB lookup or scrypt work
    const { current_password, new_password } = req.body || {};
    if (typeof current_password !== 'string' || typeof new_password !== 'string') {
      throw new ApiError(400, 'bad_input', 'current_password and new_password are required');
    }
    const r = verifyCredential(db, req.user.username, current_password, ip);
    if (!r.ok) {
      throw new ApiError(403, 'bad_current_password', 'Current password is incorrect');
    }
    const user = r.user;
    if (new_password.length < 8) {
      throw new ApiError(400, 'weak_password', 'New password must be at least 8 characters');
    }
    if (new_password === user.username || new_password === current_password) {
      throw new ApiError(400, 'weak_password', 'New password must differ from username and current password');
    }
    db.prepare(
      `UPDATE users SET pass_hash = ?, must_change_password = 0,
         token_epoch = token_epoch + 1 WHERE id = ?`
    ).run(hashPassword(new_password), user.id);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    audit(db, user.id, 'auth.password_changed', { username: user.username });
    issueCookie(res, fresh);
    return { ok: true };
  });

  // Self-revocation for anyone; targeting another user requires admin. Epoch
  // bump kills every outstanding token; the caller gets a fresh cookie so a
  // self-revoke doesn't log them out of the session they're using.
  router.post('/api/auth/revoke-sessions', [], (req, res) => {
    let targetId = req.user.id;
    if (req.body?.user_id !== undefined && Number(req.body.user_id) !== req.user.id) {
      if (req.user.role !== 'admin') {
        throw new ApiError(403, 'forbidden', 'Only admins can revoke other users’ sessions');
      }
      targetId = Number(req.body.user_id);
      if (!Number.isInteger(targetId) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(targetId)) {
        throw new ApiError(404, 'not_found', `No user ${req.body.user_id}`);
      }
    }
    db.prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?').run(targetId);
    audit(db, req.user.id, 'auth.sessions_revoked', { target_user_id: targetId });
    if (targetId === req.user.id) {
      issueCookie(res, db.prepare('SELECT * FROM users WHERE id = ?').get(targetId));
    }
    return { ok: true };
  });
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
}

module.exports = {
  mount, resolveUser, resolveConfig, verifyManagerCredential, createRateLimiter,
  hashPassword, verifyPassword, randomCode, audit,
};
