'use strict';
// Security-specific probes: burst-login behavior, token forgery/epoch handling,
// audit hygiene (no passwords in the trail), and static-path traversal guards.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');

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
