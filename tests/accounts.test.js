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

// minimal cookie-carrying client (+ raw() for non-JSON responses like CSV)
function client(base) {
  let cookie = '';
  const call = async (method, apiPath, body) => {
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
  call.raw = (apiPath) => fetch(base + apiPath, { headers: { cookie } });
  return call;
}

async function login(base, username) {
  const c = client(base);
  const r = await c('POST', '/api/auth/login', { username, password: username });
  assert.equal(r.status, 200, `login as ${username}`);
  return c;
}

function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function journalSection(report, title) {
  return report.sections.find((s) => s.title === title);
}

// Sum debit/credit per account code across all days in the journal section.
function byCode(report) {
  const out = new Map();
  for (const r of journalSection(report, 'Journal').rows) {
    if (!out.has(r.code)) out.set(r.code, { debit: 0, credit: 0 });
    out.get(r.code).debit += r.debit_cents;
    out.get(r.code).credit += r.credit_cents;
  }
  return out;
}

const JOURNAL_RANGE = `?from=${localDay(-1)}&to=${localDay(0)}`;

test('accounts: default chart, mappings, roles, CRUD', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const admin = await login(base, 'admin');
  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');

  let accounts;
  await t.test('fresh install has the full default chart', async () => {
    const r = await admin('GET', '/api/accounts');
    assert.equal(r.status, 200);
    accounts = r.data.accounts;
    const codes = accounts.map((a) => a.code);
    for (const code of ['1000', '1010', '2200', '4000', '4100', '4200', '4900', '9999']) {
      assert.ok(codes.includes(code), `chart has ${code}`);
    }
    const unmapped = accounts.find((a) => a.code === '9999');
    assert.equal(unmapped.name, 'Unmapped');
  });

  await t.test('default mappings cover seeded products, tax groups, tenders, discounts', async () => {
    const r = await admin('GET', '/api/accounts/map');
    assert.equal(r.status, 200);
    const { mappings, targets } = r.data;
    const has = (scope, key) =>
      mappings.some((m) => m.scope === scope && String(m.ref_key) === String(key));
    for (const p of targets.products) assert.ok(has('product', p.id), `product ${p.sku} mapped`);
    for (const g of targets.tax_groups) assert.ok(has('tax_group', g.id), `tax group ${g.id} mapped`);
    for (const m of ['cash', 'card_sim']) assert.ok(has('tender', m), `tender ${m} mapped`);
    for (const d of targets.discounts) assert.ok(has('discount', d.id), `discount ${d.code} mapped`);
    // spot check: ticket products map to 4000 Admission Income
    const income4000 = accounts.find((a) => a.code === '4000').id;
    const adult = targets.products.find((p) => p.sku === 'ADULT');
    const m = mappings.find((x) => x.scope === 'product' && x.ref_key === String(adult.id));
    assert.equal(m.account_id, income4000);
  });

  await t.test('journal works with no activity and no manual setup', async () => {
    const r = await manager('GET', '/api/accounts/journal' + JOURNAL_RANGE);
    assert.equal(r.status, 200);
    assert.equal(journalSection(r.data, 'Journal').rows.length, 0);
    assert.equal(journalSection(r.data, 'Daily totals').rows.length, 0);
  });

  await t.test('role gates: cashier blocked, manager read-only, admin edits', async () => {
    assert.equal((await cashier('GET', '/api/accounts')).status, 403);
    assert.equal((await cashier('GET', '/api/accounts/journal')).status, 403);
    assert.equal((await manager('GET', '/api/accounts')).status, 200);
    assert.equal((await manager('POST', '/api/accounts', { code: '5000', name: 'X', kind: 'expense' })).status, 403);
    assert.equal((await manager('PUT', '/api/accounts/map', { scope: 'tender', ref_key: 'cash', account_id: 1 })).status, 403);
  });

  await t.test('account create/update, dup code, bad kind, suspense guard', async () => {
    const created = await admin('POST', '/api/accounts', { code: '5000', name: 'Misc Expense', kind: 'expense' });
    assert.equal(created.status, 200);
    assert.equal(created.data.account.code, '5000');
    assert.equal((await admin('POST', '/api/accounts', { code: '5000', name: 'Dup', kind: 'expense' })).status, 409);
    assert.equal((await admin('POST', '/api/accounts', { code: '5001', name: 'Bad', kind: 'weird' })).status, 400);
    const upd = await admin('PUT', `/api/accounts/${created.data.account.id}`, { name: 'Misc Expenses' });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.account.name, 'Misc Expenses');
    const suspense = (await admin('GET', '/api/accounts')).data.accounts.find((a) => a.code === '9999');
    assert.equal((await admin('PUT', `/api/accounts/${suspense.id}`, { code: '8888' })).status, 400);
  });

  await t.test('mapping validation: bad scope, bad ref, bad account, clear', async () => {
    assert.equal((await admin('PUT', '/api/accounts/map', { scope: 'venue', ref_key: '1', account_id: 1 })).status, 400);
    assert.equal((await admin('PUT', '/api/accounts/map', { scope: 'tender', ref_key: 'bitcoin', account_id: 1 })).status, 400);
    assert.equal((await admin('PUT', '/api/accounts/map', { scope: 'product', ref_key: '99999', account_id: 1 })).status, 400);
    assert.equal((await admin('PUT', '/api/accounts/map', { scope: 'tender', ref_key: 'cash', account_id: 99999 })).status, 400);
    const cleared = await admin('PUT', '/api/accounts/map', { scope: 'tender', ref_key: 'cash', account_id: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.mapping, null);
    // restore cash -> 1000 for sanity
    const cashAcct = accounts.find((a) => a.code === '1000');
    const restored = await admin('PUT', '/api/accounts/map', { scope: 'tender', ref_key: 'cash', account_id: cashAcct.id });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.mapping.account_id, cashAcct.id);
  });
});

test('accounts: journal balances to the cent over mixed activity', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  const manager = await login(base, 'manager');

  const sellable = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const bySku = (sku) => sellable.find((p) => p.sku === sku);

  // 1) POS sale with SAVE10, split cash+card tender with change
  const o1 = await cashier('POST', '/api/pos/orders', {
    lines: [
      { product_id: bySku('ADULT').id, qty: 2 },
      { product_id: bySku('PARK').id, qty: 1 },
    ],
    discount_code: 'SAVE10',
  });
  assert.equal(o1.status, 200);
  const order1 = o1.data.order;
  assert.ok(order1.discount_cents > 0);
  const fin1 = await cashier('POST', `/api/pos/orders/${order1.id}/finalize`, {
    payments: [
      { method: 'card_sim', amount_cents: 2000 },
      { method: 'cash', amount_cents: order1.total_cents - 2000 + 300 },
    ],
  });
  assert.equal(fin1.status, 200);
  assert.equal(fin1.data.change_cents, 300);

  // 2) web order through the real store checkout (ticket + membership)
  const web = await client(base)('POST', '/api/store/checkout', {
    lines: [
      { product_id: bySku('CHILD').id, qty: 1 },
      { product_id: bySku('MEM-EXP').id, qty: 1 },
    ],
    customer: { name: 'Webb Guest', email: 'webb@example.com' },
    card: { number: '4242 4242 4242 4242' },
  });
  assert.equal(web.status, 200);

  // 3) POS sale then a full refund the same day
  const o3 = await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: bySku('SENIOR').id, qty: 1 }],
  });
  assert.equal(o3.status, 200);
  const order3 = o3.data.order;
  const fin3 = await cashier('POST', `/api/pos/orders/${order3.id}/finalize`, {
    payments: [{ method: 'cash', amount_cents: order3.total_cents }],
  });
  assert.equal(fin3.status, 200);
  const refund = await manager('POST', `/api/pos/orders/${order3.id}/refund`, {});
  assert.equal(refund.status, 200);

  const r = await manager('GET', '/api/accounts/journal' + JOURNAL_RANGE);
  assert.equal(r.status, 200);
  const report = r.data;

  await t.test('every day balances: debits equal credits', () => {
    const days = journalSection(report, 'Daily totals').rows;
    assert.ok(days.length >= 1, 'at least one day of activity');
    for (const d of days) {
      assert.equal(d.difference_cents, 0, `day ${d.date} out of balance`);
      assert.equal(d.debit_cents, d.credit_cents, `day ${d.date}`);
      assert.ok(d.debit_cents > 0, `day ${d.date} has activity`);
    }
    const totals = journalSection(report, 'Journal').totals;
    assert.equal(totals.debit_cents, totals.credit_cents, 'grand totals balance');
  });

  await t.test('legs land on the mapped accounts', () => {
    const codes = byCode(report);
    // discounts debited exactly the order's discount
    assert.equal(codes.get('4900').debit, order1.discount_cents);
    // membership income credited at gross
    assert.equal(codes.get('4100').credit, bySku('MEM-EXP').price_cents);
    // admission income: adult x2 + child + senior credited, senior refund debited back
    const admissionGross =
      2 * bySku('ADULT').price_cents + bySku('CHILD').price_cents + bySku('SENIOR').price_cents;
    assert.equal(codes.get('4000').credit, admissionGross);
    assert.equal(codes.get('4000').debit, bySku('SENIOR').price_cents);
    // refund nets the reversal: cash clearing credited the refunded total
    assert.equal(codes.get('1000').credit, order3.total_cents);
    // tax liability reversed for the refund
    assert.equal(codes.get('2200').debit, order3.tax_cents);
    // nothing hit suspense — everything was mapped
    assert.ok(!codes.has('9999'));
  });

  await t.test('CSV export via the shared report format', async () => {
    const res = await manager.raw('/api/accounts/journal' + JOURNAL_RANGE + '&format=csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const text = await res.text();
    assert.match(text, /Journal/);
    assert.match(text, /Daily totals/);
    assert.match(text, /4900/);
  });
});

test('accounts: unmapped product posts to 9999 suspense, then remaps', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const admin = await login(base, 'admin');
  const cashier = await login(base, 'cashier');

  // a just-created product has no mapping (defaults were seeded at first mount)
  const taxGroups = (await admin('GET', '/api/catalog/tax-groups')).data.tax_groups;
  const nonTax = taxGroups.find((g) => g.rate_bp === 0);
  const created = await admin('POST', '/api/catalog/products', {
    sku: 'NEWP', name: 'Novelty Plush', kind: 'addon', price_cents: 1000,
    tax_group_id: nonTax.id, channels: ['pos'],
  });
  assert.equal(created.status, 200);
  const newId = created.data.product.id;

  const sell = async () => {
    const o = await cashier('POST', '/api/pos/orders', { lines: [{ product_id: newId, qty: 1 }] });
    assert.equal(o.status, 200);
    const fin = await cashier('POST', `/api/pos/orders/${o.data.order.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: o.data.order.total_cents }],
    });
    assert.equal(fin.status, 200);
  };
  await sell();

  await t.test('revenue appears on the Unmapped line and still balances', async () => {
    const r = await admin('GET', '/api/accounts/journal' + JOURNAL_RANGE);
    assert.equal(r.status, 200);
    const codes = byCode(r.data);
    assert.equal(codes.get('9999').credit, 1000);
    for (const d of journalSection(r.data, 'Daily totals').rows) {
      assert.equal(d.difference_cents, 0);
    }
  });

  await t.test('mapping the product moves its revenue off suspense', async () => {
    const accounts = (await admin('GET', '/api/accounts')).data.accounts;
    const addonIncome = accounts.find((a) => a.code === '4200');
    const m = await admin('PUT', '/api/accounts/map', {
      scope: 'product', ref_key: String(newId), account_id: addonIncome.id,
    });
    assert.equal(m.status, 200);
    await sell();
    const r = await admin('GET', '/api/accounts/journal' + JOURNAL_RANGE);
    const codes = byCode(r.data);
    assert.ok(!codes.has('9999'), 'suspense line gone after mapping');
    assert.equal(codes.get('4200').credit, 2000);
  });
});
