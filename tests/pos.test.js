'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const eventsMod = require('../server/modules/events');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer() {
  const { server, db, ctx } = createApp(tempDb());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, ctx, base };
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

test('pos: pricing, posting path, tenders, void/refund', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());

  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  const mgr = client(base);
  await mgr('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  // seed lookups
  const { data: sell } = await cashier('GET', '/api/catalog/sellable?channel=pos');
  const bySku = Object.fromEntries(sell.products.map((p) => [p.sku, p]));
  const adult = bySku.ADULT;   // 2995, 625bp
  const plntm = bySku.PLNTM;   // 900, 625bp, event-linked
  const memExp = bySku['MEM-EXP']; // 9900, 0bp, membership

  const { data: evData } = await mgr('GET', '/api/events');
  const planetarium = evData.events.find((e) => e.name === 'Planetarium Show');
  const sessRes = await fetch(base + `/api/events/${planetarium.id}/sessions`);
  const { sessions } = await sessRes.json();
  assert.ok(sessions.length >= 10);

  await t.test('auth: anonymous 401, gate role 403', async () => {
    const anon = await fetch(base + '/api/pos/orders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(anon.status, 401);
    const gate = client(base);
    await gate('POST', '/api/auth/login', { username: 'gate', password: 'gate' });
    const r = await gate('POST', '/api/pos/orders', { lines: [{ product_id: adult.id, qty: 1 }] });
    assert.equal(r.status, 403);
  });

  await t.test('createOrder validation: bad product, missing session, bad discount', async () => {
    let r = await cashier('POST', '/api/pos/orders', { lines: [] });
    assert.equal(r.status, 400);
    r = await cashier('POST', '/api/pos/orders', { lines: [{ product_id: 999999, qty: 1 }] });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_product');
    r = await cashier('POST', '/api/pos/orders', { lines: [{ product_id: plntm.id, qty: 1 }] });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'session_required');
    r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }], discount_code: 'NOPE',
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_discount');
    r = await cashier('POST', '/api/pos/orders', { lines: [{ product_id: adult.id, qty: 0 }] });
    assert.equal(r.status, 400);
  });

  await t.test('scenario: two adults + planetarium — per-line tax and grand total', async () => {
    const s = sessions[0];
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: adult.id, qty: 2 },
        { product_id: plntm.id, qty: 1, event_session_id: s.id },
      ],
    });
    assert.equal(r.status, 200);
    const o = r.data.order;
    assert.equal(o.status, 'open');
    assert.equal(o.lines.length, 2);
    // adult: 2×2995=5990 gross, tax round(5990*625/10000)=374
    assert.equal(o.lines[0].tax_cents, 374);
    assert.equal(o.lines[0].line_total_cents, 6364);
    // planetarium: 900 gross, tax 56
    assert.equal(o.lines[1].tax_cents, 56);
    assert.equal(o.lines[1].event_session_id, s.id);
    assert.equal(o.subtotal_cents, 6890);
    assert.equal(o.tax_cents, 430);
    assert.equal(o.total_cents, 7320);
    assert.equal(o.confirmation, null); // assigned at finalize
  });

  await t.test('discount SAVE10: proportional allocation, tax on discounted amounts', async () => {
    const s = sessions[1];
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: adult.id, qty: 2 },
        { product_id: plntm.id, qty: 1, event_session_id: s.id },
      ],
      discount_code: 'save10', // case-insensitive
    });
    assert.equal(r.status, 200);
    const o = r.data.order;
    assert.equal(o.discount_code, 'SAVE10');
    assert.equal(o.discount_cents, 689); // 10% of 6890
    assert.equal(o.lines[0].discount_cents, 599);
    assert.equal(o.lines[1].discount_cents, 90);
    assert.equal(o.lines[0].tax_cents, 337); // round(5391*.0625)
    assert.equal(o.lines[1].tax_cents, 51);  // round(810*.0625)
    assert.equal(o.tax_cents, 388);
    assert.equal(o.total_cents, 6589);
  });

  await t.test('scenario: cash with change', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    assert.equal(o.total_cents, 3182); // 2995 + 187 tax
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: 5000 }],
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.change_cents, 1818);
    assert.equal(fin.data.order.status, 'paid');
    assert.ok(fin.data.order.paid_at);
    assert.match(fin.data.order.confirmation, /^P-[A-Z0-9]{9}$/);
    // payments row records both amounts
    assert.equal(fin.data.order.payments.length, 1);
    assert.equal(fin.data.order.payments[0].amount_cents, 5000);
    assert.equal(fin.data.order.payments[0].change_cents, 1818);
    // one ticket, T- code, valid window from product
    assert.equal(fin.data.tickets.length, 1);
    const tk = fin.data.tickets[0];
    assert.match(tk.code, /^T-[A-Z0-9]{10}$/);
    assert.equal(tk.uses_remaining, adult.max_uses);
    assert.ok(Date.parse(tk.valid_to) - Date.parse(tk.valid_from) >= adult.validity_days * (24 * 3600 * 1000) - 1000);
  });

  await t.test('insufficient tender cannot finalize; order stays open and can retry', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    const short = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: o.total_cents - 1 }],
    });
    assert.equal(short.status, 400);
    assert.equal(short.data.error, 'insufficient_tender');
    const after = await cashier('GET', `/api/pos/orders/${o.id}`);
    assert.equal(after.data.order.status, 'open');
    assert.equal(after.data.order.tickets.length, 0);
    assert.equal(after.data.order.payments.length, 0);
    // retry with full amount succeeds
    const ok = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: o.total_cents }],
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.order.payments[0].ref.length > 0); // fake auth ref generated
  });

  await t.test('split tender: card + cash, change from cash only', async () => {
    const s = sessions[2];
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: adult.id, qty: 2 },
        { product_id: plntm.id, qty: 1, event_session_id: s.id },
      ],
    });
    const o = r.data.order; // 7320
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [
        { method: 'card_sim', amount_cents: 5000, ref: 'AUTH-TEST' },
        { method: 'cash', amount_cents: 3000 },
      ],
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.change_cents, 680);
    const pays = fin.data.order.payments;
    assert.equal(pays.length, 2);
    assert.equal(pays[0].method, 'card_sim');
    assert.equal(pays[0].ref, 'AUTH-TEST');
    assert.equal(pays[0].change_cents, 0);
    assert.equal(pays[1].method, 'cash');
    assert.equal(pays[1].change_cents, 680);
    // capacity was counted
    assert.equal(eventsMod.getSession(db, s.id).sold, 1);
    // three tickets: 2 adult + 1 planetarium (session on the right one)
    assert.equal(fin.data.tickets.length, 3);
    assert.equal(fin.data.tickets.filter((x) => x.event_session_id === s.id).length, 1);
  });

  await t.test('card over-tender (change without cash) is rejected', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: o.total_cents + 500 }],
    });
    assert.equal(fin.status, 400);
    assert.equal(fin.data.error, 'bad_tender');
  });

  await t.test('scenario: capacity failure rolls back everything (shared invariant)', async () => {
    const s = sessions[3];
    db.prepare('UPDATE event_sessions SET capacity = 1 WHERE id = ?').run(s.id);
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: adult.id, qty: 1 },
        { product_id: plntm.id, qty: 2, event_session_id: s.id },
      ],
    });
    const o = r.data.order;
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: 100000 }],
    });
    assert.equal(fin.status, 409);
    assert.equal(fin.data.error, 'capacity');
    // rollback: order open, no tickets, no payments, sold untouched
    const after = await cashier('GET', `/api/pos/orders/${o.id}`);
    assert.equal(after.data.order.status, 'open');
    assert.equal(after.data.order.tickets.length, 0);
    assert.equal(after.data.order.payments.length, 0);
    assert.equal(eventsMod.getSession(db, s.id).sold, 0);
  });

  await t.test('membership sale creates a member; renewal extends expiry', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: memExp.id, qty: 1 }],
      customer: { name: 'Pat Tester', email: 'pat@example.com' },
    });
    const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: r.data.order.total_cents }],
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.members.length, 1);
    const m = fin.data.members[0];
    assert.equal(m.name, 'Pat Tester');
    assert.match(m.member_no, /^GM-/);
    assert.match(m.pass_code, /^M-/);
    const firstExpiry = Date.parse(m.expires_at);

    // renewal via explicit member field on the line
    const r2 = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: memExp.id, qty: 1, member: { member_id: m.id } }],
    });
    assert.match(r2.data.order.lines[0].description, /renewal #/);
    const fin2 = await cashier('POST', `/api/pos/orders/${r2.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: r2.data.order.total_cents }],
    });
    assert.equal(fin2.status, 200);
    assert.equal(fin2.data.members[0].id, m.id); // same member, not a new one
    const secondExpiry = Date.parse(fin2.data.members[0].expires_at);
    const gainDays = (secondExpiry - firstExpiry) / (24 * 3600 * 1000);
    assert.ok(gainDays > 364 && gainDays < 366, `expected ~365 more days, got ${gainDays}`);
  });

  await t.test('double-finalize is rejected', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: o.total_cents }],
    });
    const again = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: o.total_cents }],
    });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'order_not_open');
  });

  await t.test('scenario: refund releases capacity, voids tickets, blocks the gate', async () => {
    const s = sessions[4];
    const soldBefore = eventsMod.getSession(db, s.id).sold;
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: adult.id, qty: 1 },
        { product_id: plntm.id, qty: 1, event_session_id: s.id },
      ],
    });
    const o = r.data.order; // 4138
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: o.total_cents }],
    });
    assert.equal(fin.status, 200);
    assert.equal(eventsMod.getSession(db, s.id).sold, soldBefore + 1);
    const adultTicket = fin.data.tickets.find((x) => x.event_session_id === null);

    // cashier cannot refund
    const deny = await cashier('POST', `/api/pos/orders/${o.id}/refund`, {});
    assert.equal(deny.status, 403);

    // manager refunds
    const ref = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {});
    assert.equal(ref.status, 200);
    assert.equal(ref.data.order.status, 'refunded');
    assert.ok(ref.data.order.refunded_at);
    assert.equal(ref.data.voided_tickets, 2);
    assert.ok(ref.data.order.tickets.every((x) => x.status === 'void'));
    assert.equal(eventsMod.getSession(db, s.id).sold, soldBefore); // capacity released
    // negative payment row nets the refund
    const neg = ref.data.order.payments.filter((p) => p.amount_cents < 0);
    assert.equal(neg.length, 1);
    assert.equal(neg[0].amount_cents, -o.total_cents);
    // payments net to zero for the order
    const net = ref.data.order.payments.reduce((a, p) => a + p.amount_cents - p.change_cents, 0);
    assert.equal(net, 0);

    // refunded ticket scans as denied with reason "void"
    const scan = await mgr('POST', '/api/admissions/scan', { code: adultTicket.code, gate: 'main' });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.result, 'denied');
    assert.equal(scan.data.reason, 'void');

    // cannot refund twice
    const again = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {});
    assert.equal(again.status, 409);
  });

  await t.test('void: manager only, open orders only, cannot finalize after', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    assert.equal((await cashier('POST', `/api/pos/orders/${o.id}/void`, {})).status, 403);
    const v = await mgr('POST', `/api/pos/orders/${o.id}/void`, {});
    assert.equal(v.status, 200);
    assert.equal(v.data.order.status, 'void');
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: 99999 }],
    });
    assert.equal(fin.status, 409);
    const rv = await mgr('POST', `/api/pos/orders/${o.id}/void`, {});
    assert.equal(rv.status, 409); // not voidable twice
  });

  await t.test('scenario: reprint — order search + detail return lines, payments, tickets', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
      customer: { name: 'Rita Reprint', email: 'rita@example.com' },
    });
    const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: r.data.order.total_cents }],
    });
    const conf = fin.data.order.confirmation;

    const byConf = await cashier('GET', '/api/pos/orders?q=' + encodeURIComponent(conf));
    assert.equal(byConf.status, 200);
    assert.equal(byConf.data.orders.length, 1);
    const byName = await cashier('GET', '/api/pos/orders?q=Rita');
    assert.ok(byName.data.orders.some((x) => x.confirmation === conf));

    const detail = await cashier('GET', `/api/pos/orders/${byConf.data.orders[0].id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.order.confirmation, conf);
    assert.equal(detail.data.order.lines.length, 1);
    assert.equal(detail.data.order.payments.length, 1);
    assert.equal(detail.data.order.tickets.length, 1);
    assert.match(detail.data.order.tickets[0].code, /^T-/);

    const missing = await cashier('GET', '/api/pos/orders/999999');
    assert.equal(missing.status, 404);
  });

  await t.test('zero-discount edge: amount discount capped at subtotal', async () => {
    // create a 100%-plus amount discount as admin and make sure total floors at tax-only
    const admin = client(base);
    await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin' });
    const mk = await admin('POST', '/api/catalog/discounts', {
      code: 'BIGAMT', name: 'Huge amount', kind: 'amount', value: 999999,
    });
    assert.equal(mk.status, 200);
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }], discount_code: 'BIGAMT',
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.discount_cents, 2995); // capped at subtotal
    assert.equal(r.data.order.tax_cents, 0);
    assert.equal(r.data.order.total_cents, 0);
    // zero-total order finalizes with no payments
    const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, { payments: [] });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.change_cents, 0);
    assert.equal(fin.data.order.status, 'paid');
  });
});

test('pos: shared posting path is callable by other modules (store contract)', async (t) => {
  const { server, db, ctx } = createApp(tempDb());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const pos = ctx.modules.pos;

  // store-style usage: createOrder(db, ctx, payload, 'web') then finalizeOrder
  const adult = db.prepare("SELECT * FROM products WHERE sku = 'ADULT'").get();
  const order = pos.createOrder(
    db, ctx,
    {
      lines: [{ product_id: adult.id, qty: 1 }],
      customer: { name: 'Web Guest', email: 'guest@example.com' },
      confirmation: 'W-TESTTEST',
    },
    'web'
  );
  assert.equal(order.channel, 'web');
  assert.equal(order.confirmation, 'W-TESTTEST'); // store-supplied confirmation kept
  const result = pos.finalizeOrder(db, ctx, order.id, [
    { method: 'card_sim', amount_cents: order.total_cents },
  ]);
  assert.equal(result.order.status, 'paid');
  assert.equal(result.order.confirmation, 'W-TESTTEST');
  assert.equal(result.change_cents, 0);
  assert.equal(result.tickets.length, 1);

  // finalize with no confirmation on a web order gets W- prefix
  const order2 = pos.createOrder(
    db, ctx, { lines: [{ product_id: adult.id, qty: 1 }] }, 'web'
  );
  const result2 = pos.finalizeOrder(db, ctx, order2.id, [
    { method: 'card_sim', amount_cents: order2.total_cents },
  ]);
  assert.match(result2.order.confirmation, /^W-[A-Z0-9]{9}$/);
});
