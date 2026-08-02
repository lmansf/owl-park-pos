'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer() {
  const { server, db } = createApp(tempDb());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, base };
}

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

test('barcode: encodes ticket codes, rejects bad chars', () => {
  const { barcode39Svg } = require('../web/lib/barcode.js');
  const svg = barcode39Svg('T-ABC123XYZ9');
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('T-ABC123XYZ9'));
  assert.throws(() => barcode39Svg('lower_case!'));
});
