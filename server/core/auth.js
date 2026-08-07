'use strict';
const crypto = require('node:crypto');
const net = require('node:net');
const { ApiError } = require('./http');
const { now } = require('./db');

const SESSION_HOURS = 12;
const LOCKOUT_FAILS = 5;        // consecutive failures before a timed lock
const LOCKOUT_MINUTES = 15;
const RATE_LIMIT_ATTEMPTS = 20;      // per bucket, per window, checked before any scrypt work
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_IP_CEILING = 120;   // per-IP backstop across all accounts (bounds scrypt burn)
const RATE_LIMIT_MAX_TRACKED = 10_000; // hard cap on tracked buckets (forged keys can't OOM us)

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
  return {
    mode,
    secret,
    secure: mode === 'production' || Boolean(env.VERCEL),
    trustProxy: trustProxy(env),
  };
}

// OWLPOS_TRUST_PROXY=1 declares that exactly one trusted reverse proxy sits in
// front of the app (the production topology in docs/production-roadmap.md), so
// the real client address is the RIGHTMOST X-Forwarded-For entry — the one that
// proxy appended. It is an explicit opt-in: X-Forwarded-For is client-writable,
// and honoring it on a directly exposed server would let an attacker pick their
// own rate-limit bucket per request.
function trustProxy(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.OWLPOS_TRUST_PROXY || ''));
}

// Explicit, safe client-IP resolution: the TCP peer address unless a trusted
// proxy is declared. Falls back to the peer when the forwarded value is not a
// syntactically valid IP.
function clientIp(req, trusted = trustProxy()) {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (!trusted) return peer;
  const forwarded = String(req.headers?.['x-forwarded-for'] || '');
  const last = forwarded.split(',').pop().trim();
  return net.isIP(last) ? last : peer;
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

// Fixed-window limiter factory. Buckets key on the resolved client IP by
// default; `key(req, ip)` narrows that (e.g. per account). Each caller gets its
// own closure-scoped bucket so parallel createApp instances (tests, serverless
// warm starts) never share state, and login vs. approver traffic can't starve
// each other. Pruned inline — no setInterval, which would keep test processes
// alive and is serverless-hostile — and hard-capped so attacker-chosen keys
// can't grow the map without bound. The returned guard runs before any scrypt
// work.
function createRateLimiter({ max = RATE_LIMIT_ATTEMPTS, trusted, key } = {}) {
  const attempts = new Map(); // bucket key -> { count, windowStart }
  return function rateLimit(req, res) {
    const ip = clientIp(req, trusted ?? trustProxy());
    const bucket = key ? key(req, ip) : ip;
    const t = Date.now();
    for (const [k, v] of attempts) {
      if (t - v.windowStart >= RATE_LIMIT_WINDOW_MS) attempts.delete(k);
    }
    if (!attempts.has(bucket) && attempts.size >= RATE_LIMIT_MAX_TRACKED) {
      attempts.delete(attempts.keys().next().value); // evict the oldest bucket
    }
    const slot = attempts.get(bucket) || { count: 0, windowStart: t };
    slot.count++;
    attempts.set(bucket, slot);
    if (slot.count > max) {
      res.setHeader('retry-after', Math.ceil((slot.windowStart + RATE_LIMIT_WINDOW_MS - t) / 1000));
      throw new ApiError(429, 'too_many_attempts', 'Too many attempts — try again shortly');
    }
    return ip;
  };
}

function mount(router, db, config) {
  // Two-tier throttle for the credential routes. The primary bucket keys on
  // (client IP, account) so a flood of garbage usernames cannot 429 every
  // station in the venue — behind a reverse proxy all stations share one peer
  // address, so set OWLPOS_TRUST_PROXY there to key on real client IPs. The
  // wider per-IP ceiling still bounds the total scrypt work one address can
  // force by rotating usernames. Login keys on the attempted username (body),
  // change-password on the session user — same account, same bucket, so a
  // stolen cookie can't sidestep the login throttle. The session user wins over
  // the body so a cookie holder can't mint fresh buckets via a forged username
  // field.
  const accountKey = (req, ip) =>
    `${ip}|${String(req.user?.username ?? req.body?.username ?? '').toLowerCase().slice(0, 64)}`;
  const rateLimit = createRateLimiter({ trusted: config.trustProxy, key: accountKey });
  const floodLimit = createRateLimiter({ trusted: config.trustProxy, max: RATE_LIMIT_IP_CEILING });

  function issueCookie(res, user) {
    const token = signToken(
      config, user.username, user.token_epoch, Date.now() + SESSION_HOURS * 3600_000
    );
    res.setHeader('set-cookie', `opsid=${token}; ${cookieFlags(config)}`);
  }

  router.post('/api/auth/login', null, (req, res) => {
    const ip = rateLimit(req, res); // before any DB lookup or scrypt work
    floodLimit(req, res);
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

  // Sessions are stateless, so clearing the browser cookie alone leaves a
  // captured token string valid until its 12h exp. Sign-out must actually
  // revoke: bump token_epoch (like change-password does), which kills every
  // outstanding token for the user — the right call on shared POS terminals.
  router.post('/api/auth/logout', [], (req, res) => {
    db.prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?').run(req.user.id);
    audit(db, req.user.id, 'auth.logout', { username: req.user.username });
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
    floodLimit(req, res);
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
  clientIp, hashPassword, verifyPassword, randomCode, audit,
};
