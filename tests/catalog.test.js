'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const { getSellable, validateDiscount } = require('../server/modules/catalog');

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

async function login(base, username) {
  const c = client(base);
  const r = await c('POST', '/api/auth/login', { username, password: username });
  assert.equal(r.status, 200, `login as ${username}`);
  return c;
}

test('catalog: sellable feed', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  const manager = await login(base, 'manager');

  await t.test('requires sign-in', async () => {
    const anon = client(base);
    const r = await anon('GET', '/api/catalog/sellable?channel=pos');
    assert.equal(r.status, 401);
  });

  await t.test('rejects bad channel', async () => {
    const r = await cashier('GET', '/api/catalog/sellable?channel=kiosk');
    assert.equal(r.status, 400);
  });

  await t.test('returns seeded products with resolved tax rate', async () => {
    const r = await cashier('GET', '/api/catalog/sellable?channel=pos');
    assert.equal(r.status, 200);
    assert.equal(r.data.products.length, 7);
    const adult = r.data.products.find((p) => p.sku === 'ADULT');
    assert.deepEqual(
      Object.keys(adult).sort(),
      ['event_id', 'id', 'kind', 'max_uses', 'membership_program_id',
       'name', 'price_cents', 'sku', 'tax_rate_bp', 'validity_days'].sort()
    );
    assert.equal(adult.price_cents, 2995);
    assert.equal(adult.tax_rate_bp, 625);
    const park = r.data.products.find((p) => p.sku === 'PARK');
    assert.equal(park.tax_rate_bp, 0);
    const plntm = r.data.products.find((p) => p.sku === 'PLNTM');
    assert.ok(plntm.event_id, 'event-linked product exposes event_id');
    const mem = r.data.products.find((p) => p.sku === 'MEM-EXP');
    assert.equal(mem.membership_program_id, 1);
  });

  await t.test('channel filter: web-only product hidden from pos', async () => {
    const create = await manager('POST', '/api/catalog/products', {
      sku: 'WEBONLY', name: 'Web Exclusive Pass', kind: 'ticket',
      price_cents: 500, tax_group_id: 1, validity_days: 7, max_uses: 1,
      channels: ['web'],
    });
    assert.equal(create.status, 200);
    const pos = await cashier('GET', '/api/catalog/sellable?channel=pos');
    const web = await cashier('GET', '/api/catalog/sellable?channel=web');
    assert.ok(!pos.data.products.some((p) => p.sku === 'WEBONLY'));
    assert.ok(web.data.products.some((p) => p.sku === 'WEBONLY'));
  });

  await t.test('one source of truth: price change shows on next feed read', async () => {
    const list = await manager('GET', '/api/catalog/products');
    const adult = list.data.products.find((p) => p.sku === 'ADULT');
    const upd = await manager('PUT', `/api/catalog/products/${adult.id}`, { price_cents: 3495 });
    assert.equal(upd.status, 200);
    for (const ch of ['pos', 'web']) {
      const feed = await cashier('GET', `/api/catalog/sellable?channel=${ch}`);
      assert.equal(feed.data.products.find((p) => p.sku === 'ADULT').price_cents, 3495);
    }
  });

  await t.test('pure getSellable works without HTTP (store reuse)', () => {
    const rows = getSellable(db, 'web');
    assert.ok(rows.length >= 7);
    assert.ok(rows.every((r) => r.tax_rate_bp !== undefined && r.channels === undefined));
  });
});

test('catalog: product CRUD, deactivate-not-delete', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');

  await t.test('cashier cannot manage products', async () => {
    const r = await cashier('POST', '/api/catalog/products', {
      sku: 'X', name: 'x', kind: 'addon', price_cents: 1, tax_group_id: 1,
    });
    assert.equal(r.status, 403);
  });

  await t.test('validation: bad kind, duplicate sku, missing tax group', async () => {
    const badKind = await manager('POST', '/api/catalog/products', {
      sku: 'BAD1', name: 'Bad', kind: 'voucher', price_cents: 100, tax_group_id: 1,
    });
    assert.equal(badKind.status, 400);
    const dupe = await manager('POST', '/api/catalog/products', {
      sku: 'adult', name: 'Dupe', kind: 'ticket', price_cents: 100, tax_group_id: 1,
    });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.data.error, 'sku_taken');
    const badTax = await manager('POST', '/api/catalog/products', {
      sku: 'BAD2', name: 'Bad', kind: 'ticket', price_cents: 100, tax_group_id: 99,
    });
    assert.equal(badTax.status, 400);
    const memNoProg = await manager('POST', '/api/catalog/products', {
      sku: 'BAD3', name: 'Bad', kind: 'membership', price_cents: 100, tax_group_id: 1,
    });
    assert.equal(memNoProg.status, 400);
  });

  await t.test('deactivate keeps history: sold product leaves feed, stays queryable', async () => {
    const list = await manager('GET', '/api/catalog/products');
    const child = list.data.products.find((p) => p.sku === 'CHILD');

    // simulate sales history directly (pos module is a separate team/wave)
    const iso = new Date().toISOString();
    db.prepare(
      "INSERT INTO orders (channel, status, customer_name, created_at, paid_at) VALUES ('pos','paid','Test Buyer',?,?)"
    ).run(iso, iso);
    const orderId = db.prepare('SELECT MAX(id) AS id FROM orders').get().id;
    db.prepare(
      'INSERT INTO order_lines (order_id, product_id, description, qty, unit_price_cents, line_total_cents) VALUES (?,?,?,?,?,?)'
    ).run(orderId, child.id, child.name, 1, child.price_cents, child.price_cents);

    const deact = await manager('PUT', `/api/catalog/products/${child.id}`, { active: 0 });
    assert.equal(deact.status, 200);
    assert.equal(deact.data.product.active, 0);
    assert.equal(deact.data.product.has_sales, 1);

    // gone from both sell surfaces
    for (const ch of ['pos', 'web']) {
      const feed = await manager('GET', `/api/catalog/sellable?channel=${ch}`);
      assert.ok(!feed.data.products.some((p) => p.sku === 'CHILD'));
    }
    // still in the back-office list and past order line still references it
    const after = await manager('GET', '/api/catalog/products');
    assert.ok(after.data.products.some((p) => p.sku === 'CHILD'));
    const line = db
      .prepare('SELECT * FROM order_lines WHERE product_id = ?')
      .get(child.id);
    assert.ok(line, 'past order line survives deactivation');

    // there is no delete route at all
    const del = await manager('DELETE', `/api/catalog/products/${child.id}`);
    assert.equal(del.status, 404);
    assert.equal(del.data.error, 'not_found');
  });

  await t.test('reactivation returns product to the feed', async () => {
    const list = await manager('GET', '/api/catalog/products');
    const child = list.data.products.find((p) => p.sku === 'CHILD');
    await manager('PUT', `/api/catalog/products/${child.id}`, { active: 1 });
    const feed = await manager('GET', '/api/catalog/sellable?channel=pos');
    assert.ok(feed.data.products.some((p) => p.sku === 'CHILD'));
  });
});

test('catalog: tax groups admin-only rates', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const admin = await login(base, 'admin');
  const manager = await login(base, 'manager');

  await t.test('manager can read, cannot edit rates', async () => {
    const list = await manager('GET', '/api/catalog/tax-groups');
    assert.equal(list.status, 200);
    assert.equal(list.data.tax_groups.length, 2);
    const put = await manager('PUT', '/api/catalog/tax-groups/1', { rate_bp: 700 });
    assert.equal(put.status, 403);
    const post = await manager('POST', '/api/catalog/tax-groups', { name: 'New', rate_bp: 100 });
    assert.equal(post.status, 403);
  });

  await t.test('admin edits a rate and the sellable feed reflects it', async () => {
    const put = await admin('PUT', '/api/catalog/tax-groups/1', { rate_bp: 700 });
    assert.equal(put.status, 200);
    assert.equal(put.data.tax_group.rate_bp, 700);
    const feed = await admin('GET', '/api/catalog/sellable?channel=pos');
    assert.equal(feed.data.products.find((p) => p.sku === 'ADULT').tax_rate_bp, 700);
  });

  await t.test('admin creates a tax group; bad rate rejected', async () => {
    const ok = await admin('POST', '/api/catalog/tax-groups', { name: 'Food 8%', rate_bp: 800 });
    assert.equal(ok.status, 200);
    const bad = await admin('POST', '/api/catalog/tax-groups', { name: 'Nope', rate_bp: -5 });
    assert.equal(bad.status, 400);
  });
});

test('catalog: discount codes', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');

  await t.test('validate seeded SAVE10, case-insensitive', async () => {
    for (const code of ['SAVE10', 'save10', ' Save10 ']) {
      const r = await cashier('POST', '/api/catalog/discounts/validate', { code });
      assert.equal(r.status, 200, `code ${JSON.stringify(code)}`);
      assert.equal(r.data.discount.kind, 'percent');
      assert.equal(r.data.discount.value, 10);
    }
  });

  await t.test('unknown code -> 404 bad_discount', async () => {
    const r = await cashier('POST', '/api/catalog/discounts/validate', { code: 'NOPE99' });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'bad_discount');
  });

  await t.test('inactive code is rejected until reactivated', async () => {
    const list = await manager('GET', '/api/catalog/discounts');
    const save10 = list.data.discounts.find((d) => d.code === 'SAVE10');
    await manager('PUT', `/api/catalog/discounts/${save10.id}`, { active: 0 });
    const off = await cashier('POST', '/api/catalog/discounts/validate', { code: 'SAVE10' });
    assert.equal(off.status, 404);
    assert.equal(validateDiscount(db, 'SAVE10'), null);
    await manager('PUT', `/api/catalog/discounts/${save10.id}`, { active: 1 });
    const on = await cashier('POST', '/api/catalog/discounts/validate', { code: 'SAVE10' });
    assert.equal(on.status, 200);
  });

  await t.test('create amount + percent discounts with validation', async () => {
    const amt = await manager('POST', '/api/catalog/discounts', {
      code: 'TAKE5', name: '$5 off', kind: 'amount', value: 500,
    });
    assert.equal(amt.status, 200);
    const v = await cashier('POST', '/api/catalog/discounts/validate', { code: 'take5' });
    assert.equal(v.data.discount.value, 500);
    const overPct = await manager('POST', '/api/catalog/discounts', {
      code: 'PCT200', name: 'Too much', kind: 'percent', value: 200,
    });
    assert.equal(overPct.status, 400);
    const dupe = await manager('POST', '/api/catalog/discounts', {
      code: 'save10', name: 'Dupe', kind: 'percent', value: 5,
    });
    assert.equal(dupe.status, 409);
    const cashierPost = await cashier('POST', '/api/catalog/discounts', {
      code: 'HAX', name: 'nope', kind: 'percent', value: 1,
    });
    assert.equal(cashierPost.status, 403);
  });

  await t.test('pure validateDiscount returns full row for store reuse', () => {
    const row = validateDiscount(db, 'TAKE5');
    assert.equal(row.kind, 'amount');
    assert.equal(row.value, 500);
    assert.equal(row.active, 1);
  });
});
