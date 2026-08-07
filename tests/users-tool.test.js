'use strict';
// tools/users.js — the operator path to a usable multi-role production venue:
// production seeding deactivates every non-admin account, and this tool is how
// they come back with a real password (no hand-editing the SQLite file).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { createApp } = require('../server/main');
const { openDb, migrate } = require('../server/core/db');
const { seed } = require('../server/core/seed');

const USERS = path.join(__dirname, '..', 'tools', 'users.js');
const MIGRATIONS = path.join(__dirname, '..', 'server', 'migrations');
const BOOTSTRAP = 'operator-bootstrap-pass';
const PROD_ENV = {
  OWLPOS_MODE: 'production', OWLPOS_SECRET: 'ef'.repeat(32),
  OWLPOS_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP,
};

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

function run(dbPath, args, password) {
  return execFileSync(process.execPath, [USERS, ...args, '--db', dbPath], {
    stdio: 'pipe',
    env: { ...process.env, OWLPOS_USER_PASSWORD: password || '' },
  }).toString();
}

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

test('users tool: activates a production account with a forced-rotation password', async (t) => {
  const dbPath = tempDb();
  {
    const db0 = openDb(dbPath);
    migrate(db0, MIGRATIONS);
    seed(db0, PROD_ENV);
    db0.close();
  }

  // password comes from the environment only — never argv — and short ones are refused
  assert.throws(() => run(dbPath, ['activate', 'cashier'], ''), /OWLPOS_USER_PASSWORD/);
  assert.throws(() => run(dbPath, ['activate', 'cashier'], 'cashier'), /OWLPOS_USER_PASSWORD/);
  // unknown accounts and unknown databases fail loudly
  assert.throws(() => run(dbPath, ['activate', 'nobody'], 'temp-pass-123'), /no account/);
  assert.throws(() => run(tempDb(), ['list']), /database not found/);

  run(dbPath, ['activate', 'cashier'], 'temp-pass-123');
  assert.match(run(dbPath, ['list']), /cashier\s+cashier\s+active/);

  const { server, db } = createApp(dbPath, { env: PROD_ENV });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cashier = client(base);

  const login = await cashier('POST', '/api/auth/login', {
    username: 'cashier', password: 'temp-pass-123',
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.must_change_password, true);

  // fenced until the temporary password is rotated
  assert.equal((await cashier('GET', '/api/pos/orders')).status, 403);
  assert.equal(
    (await cashier('POST', '/api/auth/change-password', {
      current_password: 'temp-pass-123', new_password: 'cashier-chosen-1',
    })).status,
    200
  );
  assert.equal((await cashier('GET', '/api/pos/orders')).status, 200);

  // set-password revokes existing sessions (token_epoch bump)
  run(dbPath, ['set-password', 'cashier'], 'temp-pass-456');
  assert.equal((await cashier('GET', '/api/auth/me')).status, 401);

  // deactivate disables login, but never the last active admin
  run(dbPath, ['deactivate', 'cashier']);
  const dead = await client(base)('POST', '/api/auth/login', {
    username: 'cashier', password: 'temp-pass-456',
  });
  assert.equal(dead.status, 401);
  assert.throws(() => run(dbPath, ['deactivate', 'admin']), /last active admin/);

  // every operation landed in the audit trail
  const actions = db.prepare(
    "SELECT action FROM audit_log WHERE action LIKE 'users.%' ORDER BY id"
  ).all().map((r) => r.action);
  assert.deepEqual(actions, ['users.activate', 'users.set_password', 'users.deactivate']);
});
