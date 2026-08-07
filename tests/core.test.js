'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { createApp, shutdown } = require('../server/main');
const { openDb, closeDb } = require('../server/core/db');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer(opts) {
  const { server, db } = createApp(tempDb(), opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, base };
}

// production-mode apps need an explicit strong secret and a bootstrap admin
// password (both fail-closed)
const BOOTSTRAP = 'operator-bootstrap-pass';
const PROD_ENV = {
  OWLPOS_MODE: 'production', OWLPOS_SECRET: 'ab'.repeat(32),
  OWLPOS_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP,
  OWLPOS_INIT_DB: '1', // a scratch path is always a deliberate first boot here
};

// minimal cookie-carrying client
function client(base) {
  let cookie = '';
  return async (method, apiPath, body) => {
    const res = await fetch(base + apiPath, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    return { status: res.status, data };
  };
}

test('core: boot, migrate, seed, auth, roles', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  await t.test('unauthenticated /me is 401', async () => {
    const r = await c('GET', '/api/auth/me');
    assert.equal(r.status, 401);
  });

  await t.test('bad login rejected', async () => {
    const r = await c('POST', '/api/auth/login', { username: 'admin', password: 'nope' });
    assert.equal(r.status, 401);
  });

  await t.test('login + me + logout', async () => {
    const login = await c('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'cashier');
    const me = await c('GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'cashier');
    const out = await c('POST', '/api/auth/logout', {});
    assert.equal(out.status, 200);
    const after = await c('GET', '/api/auth/me');
    assert.equal(after.status, 401);
  });

  await t.test('static shell serves', async () => {
    const res = await fetch(base + '/login.html');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /OWL PARK/);
  });
});

test('core: login lockout — 5 failures lock the account, unlock restores it', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  for (let i = 0; i < 5; i++) {
    const r = await c('POST', '/api/auth/login', { username: 'cashier', password: 'nope' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { error: 'bad_credentials', message: 'Wrong username or password' });
  }
  assert.ok(db.prepare("SELECT locked_until FROM users WHERE username = 'cashier'").get().locked_until);

  // the correct password is still rejected while locked — with the same generic body
  const locked = await c('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  assert.equal(locked.status, 401);
  assert.deepEqual(locked.data, { error: 'bad_credentials', message: 'Wrong username or password' });

  // every failure path is audit-visible
  const failed = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.login_failed'").get().n;
  assert.ok(failed >= 5, `expected >= 5 auth.login_failed rows, got ${failed}`);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.login_locked'").get().n >= 1);

  // lock expiry (simulated by clearing) → login succeeds and counters reset
  db.prepare("UPDATE users SET locked_until = NULL WHERE username = 'cashier'").run();
  const ok = await c('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  assert.equal(ok.status, 200);
  const row = db.prepare("SELECT failed_logins, locked_until FROM users WHERE username = 'cashier'").get();
  assert.equal(row.failed_logins, 0);
  assert.equal(row.locked_until, null);
});

test('core: uniform login failure + per-IP rate limit', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);

  // unknown username and wrong password are indistinguishable
  const unknown = await c('POST', '/api/auth/login', { username: 'no-such-user', password: 'x' });
  const wrong = await c('POST', '/api/auth/login', { username: 'admin', password: 'x' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.data, wrong.data);

  // burst past the per-IP window → 429s appear, with a generic body + Retry-After
  let got429 = null;
  for (let i = 0; i < 25; i++) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'x' }),
    });
    if (res.status === 429) { got429 = res; break; }
  }
  assert.ok(got429, 'expected a 429 within 25 rapid attempts');
  assert.ok(Number(got429.headers.get('retry-after')) > 0);
  assert.equal((await got429.json()).error, 'too_many_attempts');
});

test('core: change-password — policy, epoch bump, fresh cookie', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const a = client(base);
  const b = client(base); // second session on the same account
  await a('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  await b('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });

  // policy: too short / equal to current / wrong current password
  let r = await a('POST', '/api/auth/change-password', { current_password: 'cashier', new_password: 'short' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'weak_password');
  r = await a('POST', '/api/auth/change-password', { current_password: 'cashier', new_password: 42 });
  assert.equal(r.status, 400);
  r = await a('POST', '/api/auth/change-password', { current_password: 'wrong', new_password: 'longenough' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'bad_current_password');

  // success: old password dead, new one works, other session revoked, own cookie re-issued
  r = await a('POST', '/api/auth/change-password', { current_password: 'cashier', new_password: 'brand-new-pass' });
  assert.equal(r.status, 200);
  assert.equal((await a('GET', '/api/auth/me')).status, 200); // fresh cookie from the response
  assert.equal((await b('GET', '/api/auth/me')).status, 401); // pre-change cookie is dead
  assert.equal((await b('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' })).status, 401);
  assert.equal((await b('POST', '/api/auth/login', { username: 'cashier', password: 'brand-new-pass' })).status, 200);

  // new === current is rejected
  r = await a('POST', '/api/auth/change-password', { current_password: 'brand-new-pass', new_password: 'brand-new-pass' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'weak_password');
});

test('core: session revocation via token epoch', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const a = client(base);
  const b = client(base);
  await a('POST', '/api/auth/login', { username: 'manager', password: 'manager' });
  await b('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  const r = await a('POST', '/api/auth/revoke-sessions', {});
  assert.equal(r.status, 200);
  assert.equal((await b('GET', '/api/auth/me')).status, 401); // other session dead immediately
  assert.equal((await a('GET', '/api/auth/me')).status, 200); // self kept a fresh cookie

  // targeting another user requires admin
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  const deny = await cashier('POST', '/api/auth/revoke-sessions', { user_id: 1 });
  assert.equal(deny.status, 403);
  const admin = client(base);
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
  const missing = await admin('POST', '/api/auth/revoke-sessions', { user_id: 999999 });
  assert.equal(missing.status, 404);
  const ok = await admin('POST', '/api/auth/revoke-sessions', {
    user_id: (await cashier('GET', '/api/auth/me')).data.user.id,
  });
  assert.equal(ok.status, 200);
  assert.equal((await cashier('GET', '/api/auth/me')).status, 401);
});

test('core: production mode — fail-closed secret, forced password change, cookie flags', async (t) => {
  // fail-closed: no secret / short secret → createApp throws before listening
  assert.throws(() => createApp(tempDb(), { env: { OWLPOS_MODE: 'production' } }), /OWLPOS_SECRET/);
  assert.throws(
    () => createApp(tempDb(), { env: { OWLPOS_MODE: 'production', OWLPOS_SECRET: 'tooshort' } }),
    /OWLPOS_SECRET/
  );
  // …and seeding resolves mode from the SAME env: a production app with no
  // bootstrap admin password fails closed instead of seeding demo credentials
  assert.throws(
    () => createApp(tempDb(), {
      env: { OWLPOS_MODE: 'production', OWLPOS_SECRET: 'ab'.repeat(32), OWLPOS_INIT_DB: '1' },
    }),
    /OWLPOS_BOOTSTRAP_ADMIN_PASSWORD/
  );

  const { server, base } = await startServer({ env: PROD_ENV });
  t.after(() => server.close());

  // health reports the mode so the UI can hide demo hints
  assert.equal((await (await fetch(base + '/api/health')).json()).mode, 'production');

  // the demo credential does not exist in production — admin takes the bootstrap password
  const demoLogin = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(demoLogin.status, 401);

  // cookie hardening: Secure + SameSite=Strict + Max-Age matching the 12h expiry
  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: BOOTSTRAP }),
  });
  assert.equal(loginRes.status, 200);
  const setCookie = loginRes.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=43200/);
  assert.equal((await loginRes.json()).must_change_password, true);

  // seeded account is fenced in: only me/logout/change-password respond
  const cookie = setCookie.split(';')[0];
  const authed = (method, p, body) => fetch(base + p, {
    method, headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const fenced = await authed('GET', '/api/pos/orders');
  assert.equal(fenced.status, 403);
  assert.equal((await fenced.json()).error, 'password_change_required');
  assert.equal((await authed('GET', '/api/auth/me')).status, 200);

  const change = await authed('POST', '/api/auth/change-password', {
    current_password: BOOTSTRAP, new_password: 'production-pass',
  });
  assert.equal(change.status, 200);
  const freshCookie = change.headers.get('set-cookie').split(';')[0];
  const after = await fetch(base + '/api/pos/orders', { headers: { cookie: freshCookie } });
  assert.equal(after.status, 200); // fence lifts once the password is rotated
});

test('core: demo mode cookie stays HttpOnly but not Secure on plain http', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'gate', password: 'gate' }),
  });
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Secure/);
  // demo mode never fences seeded accounts, even though the flag is set
  const cookie = setCookie.split(';')[0];
  const me = await fetch(base + '/api/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).must_change_password, true);
  const scan = await fetch(base + '/api/admissions/recent', { headers: { cookie } });
  assert.notEqual(scan.status, 403);
});

test('core: seed is idempotent across restarts', async () => {
  const dbPath = tempDb();
  const app1 = createApp(dbPath);
  const users1 = app1.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  app1.db.close();
  const app2 = createApp(dbPath);
  const users2 = app2.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const products = app2.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  app2.db.close();
  assert.equal(users1, 4);
  assert.equal(users2, 4);
  assert.equal(products, 7);
});

test('core: shutdown closes the database cleanly — nothing stranded in the WAL', async () => {
  const dbPath = tempDb();
  const { server, db } = createApp(dbPath);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.ok(fs.existsSync(dbPath + '-wal'), 'a live server holds a WAL open');

  await shutdown(server, db);

  // SQLite removes the sidecars only on the last CLEAN close. Their absence is
  // what lets tools/restore.js tell a stopped server from a running one.
  assert.ok(!fs.existsSync(dbPath + '-wal'), 'no -wal left behind');
  assert.ok(!fs.existsSync(dbPath + '-shm'), 'no -shm left behind');
  const reopened = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM users').get().n, 4,
    'the whole database is in the file, not in a sidecar');
  reopened.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('core: the live database is as private as its backups', () => {
  const dbPath = tempDb();
  const db = openDb(dbPath);
  db.exec('CREATE TABLE secrets (x)'); // a write materializes the sidecars
  // scrypt hashes, member PII and plaintext gate codes live here; every copy of
  // them (backups.js, restore.js) is 0600 and the original must match.
  for (const ext of ['', '-wal', '-shm']) {
    assert.equal(fs.statSync(dbPath + ext).mode & 0o777, 0o600, `${ext || 'db'} is private`);
  }
  closeDb(db);
  // a database left lax by an older build is tightened on the next open
  fs.chmodSync(dbPath, 0o644);
  const again = openDb(dbPath);
  again.exec('INSERT INTO secrets VALUES (1)');
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dbPath + '-wal').mode & 0o777, 0o600, 'sidecars inherit the tight mode');
  closeDb(again);
});

test('core: a write waits out a cross-process lock instead of failing the sale', async () => {
  // The venue runs tools/users.js against the live database; WAL allows one
  // writer, so without a busy timeout either side dies with "database is
  // locked" — a 500 mid-tender, or a half-applied account change.
  const dbPath = tempDb();
  const db = openDb(dbPath);
  db.exec('CREATE TABLE lock_probe (x INTEGER)');
  const hold = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO lock_probe VALUES (1)').run();
    console.log('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 600);
  `;
  const holder = spawn(process.execPath, ['-e', hold, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); });
      holder.on('exit', () => reject(new Error('lock holder exited early')));
    });
    db.prepare('INSERT INTO lock_probe VALUES (2)').run(); // blocks, then commits
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lock_probe').get().n, 2);
  } finally {
    holder.kill('SIGKILL');
    closeDb(db);
  }
});

test('core: production refuses to invent a database that should already exist', () => {
  // Unmounted data volume / typo'd OWLPOS_DB: seeding a fresh demo park here
  // means a full day of real sales landing on an orphan file.
  const missing = path.join(path.dirname(tempDb()), 'not-mounted', 'owlpark-pos.db');
  assert.throws(
    () => createApp(missing, { env: { ...PROD_ENV, OWLPOS_INIT_DB: '' } }),
    /database not found/
  );
  assert.ok(!fs.existsSync(path.dirname(missing)), 'no directory tree invented');

  // …but the deliberate first boot still works, and demo mode is untouched
  const first = createApp(missing, { env: PROD_ENV });
  assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 4);
  closeDb(first.db);
  const reopen = createApp(missing, { env: { ...PROD_ENV, OWLPOS_INIT_DB: '' } });
  closeDb(reopen.db);
  const demo = createApp(path.join(path.dirname(tempDb()), 'demo', 'owlpark-pos.db'));
  closeDb(demo.db);
});

test('barcode: encodes ticket codes, rejects bad chars', () => {
  const { barcode39Svg } = require('../web/lib/barcode.js');
  const svg = barcode39Svg('T-ABC123XYZ9');
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('T-ABC123XYZ9'));
  assert.throws(() => barcode39Svg('lower_case!'));
});
