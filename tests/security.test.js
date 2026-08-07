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
const { openDb, migrate } = require('../server/core/db');
const { seed } = require('../server/core/seed');
const { verifyPassword, hashPassword } = require('../server/core/auth');

const MIGRATIONS = path.join(__dirname, '..', 'server', 'migrations');

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
  const { server, db, base } = await startServer({ env: PROD_ENV });
  t.after(() => server.close());
  const cashier = client(base);
  assert.equal(
    (await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' })).status,
    200
  );
  // the cashier rotates its own password, so only the approver is still fenced
  assert.equal(
    (await cashier('POST', '/api/auth/change-password', {
      current_password: 'cashier', new_password: 'cashier-rotated-1',
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
    approver: { username: 'manager', password: 'manager' },
  });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.data.error, 'approval_required');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'open');

  // once the manager rotates, the same approval works
  const manager = client(base);
  await manager('POST', '/api/auth/login', { username: 'manager', password: 'manager' });
  assert.equal(
    (await manager('POST', '/api/auth/change-password', {
      current_password: 'manager', new_password: 'manager-rotated-1',
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

  // after close, the session's payments are readable again (Z reconciliation)
  assert.equal((await cashier('POST', '/api/drawer/close', { counted_cents: 1 })).status, 200);
  const afterClose = await cashier('GET', `/api/pos/orders/${order.id}`);
  assert.equal(afterClose.data.order.payments.length, 1);
  assert.equal(afterClose.data.order.payments[0].amount_cents, order.total_cents + 500);
  assert.equal(
    db.prepare('SELECT drawer_session_id AS d FROM payments WHERE order_id = ?').get(order.id).d,
    sessionId
  );
});
