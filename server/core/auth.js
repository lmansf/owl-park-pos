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

function resolveUser(db) {
  return (req) => {
    const sid = req.cookies?.opsid;
    if (!sid) return null;
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.sid = ? AND s.expires_at > ? AND u.active = 1`
      )
      .get(sid, now());
    return row || null;
  };
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
    const sid = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
    db.prepare('INSERT INTO sessions (sid, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sid, user.id, now(), expires);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    audit(db, user.id, 'auth.login', { username: user.username });
    res.setHeader('set-cookie', `opsid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    return { user: publicUser(user) };
  });

  router.post('/api/auth/logout', [], (req, res) => {
    const sid = req.cookies?.opsid;
    if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    res.setHeader('set-cookie', 'opsid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return { ok: true };
  });

  router.get('/api/auth/me', [], (req) => ({ user: publicUser(req.user) }));
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
}

module.exports = { mount, resolveUser, hashPassword, verifyPassword, randomCode, audit };
