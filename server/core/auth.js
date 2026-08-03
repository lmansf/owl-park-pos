'use strict';
const crypto = require('node:crypto');
const { ApiError } = require('./http');
const { now } = require('./db');

const SESSION_HOURS = 12;

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

function randomCode(prefix, len) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ234569'; // no I/L/O/0/1 lookalikes
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return prefix + out;
}

// Sessions are stateless signed tokens (HMAC), not DB rows: on serverless hosts
// each instance has its own SQLite file, so a DB session written by one instance
// would be invisible to the next. Set OWLPOS_SECRET in multi-instance deployments
// so every instance verifies the same signature; locally the per-process fallback
// is fine. Logout clears the cookie (tokens are not revocable before expiry —
// acceptable for demo-grade auth).
const SECRET = process.env.OWLPOS_SECRET || crypto.randomBytes(32).toString('hex');

function signToken(username, expEpochMs) {
  const payload = `${Buffer.from(username).toString('base64url')}.${expEpochMs}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const given = Buffer.from(parts[2]);
  const want = Buffer.from(expect);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  try {
    return { username: Buffer.from(parts[0], 'base64url').toString('utf8'), exp };
  } catch {
    return null;
  }
}

function resolveUser(db) {
  return (req) => {
    const token = parseToken(req.cookies?.opsid);
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT id, username, display_name, role FROM users
         WHERE username = ? AND active = 1`
      )
      .get(token.username);
    return row || null;
  };
}

function cookieFlags() {
  return `Path=/; HttpOnly; SameSite=Lax${process.env.VERCEL ? '; Secure' : ''}`;
}

function audit(db, userId, action, detail) {
  db.prepare('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(now(), userId ?? null, action, detail ? JSON.stringify(detail) : null);
}

function mount(router, db) {
  router.post('/api/auth/login', null, (req, res) => {
    const { username, password } = req.body || {};
    const user = db
      .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
      .get(String(username || '').toLowerCase());
    if (!user || !verifyPassword(String(password || ''), user.pass_hash)) {
      throw new ApiError(401, 'bad_credentials', 'Wrong username or password');
    }
    const token = signToken(user.username, Date.now() + SESSION_HOURS * 3600_000);
    audit(db, user.id, 'auth.login', { username: user.username });
    res.setHeader('set-cookie', `opsid=${token}; ${cookieFlags()}`);
    return { user: publicUser(user) };
  });

  router.post('/api/auth/logout', [], (req, res) => {
    res.setHeader('set-cookie', `opsid=; ${cookieFlags()}; Max-Age=0`);
    return { ok: true };
  });

  router.get('/api/auth/me', [], (req) => ({ user: publicUser(req.user) }));
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
}

module.exports = { mount, resolveUser, hashPassword, verifyPassword, randomCode, audit };
