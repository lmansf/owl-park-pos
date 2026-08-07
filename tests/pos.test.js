'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const { openDb, migrate } = require('../server/core/db');
const { seed: seedDemo } = require('../server/core/seed');
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
  // POS cash needs an open drawer session (drawer-sessions-zreports)
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 20000 })).status, 200);

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

  await t.test('tender registry: exact public shape, anonymous 401, gate 403', async () => {
    const r = await cashier('GET', '/api/pos/tenders');
    assert.equal(r.status, 200);
    // deepEqual pins the exact serialization — no authorize hook may ever leak
    assert.deepEqual(r.data.tenders, [
      { method: 'cash', label: 'Cash', change: true },
      { method: 'card_sim', label: 'Card', change: false },
      { method: 'voucher', label: 'Voucher', change: false },
    ]);
    const anon = await fetch(base + '/api/pos/tenders');
    assert.equal(anon.status, 401);
    const gate = client(base);
    await gate('POST', '/api/auth/login', { username: 'gate', password: 'gate' });
    assert.equal((await gate('GET', '/api/pos/tenders')).status, 403);
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

  await t.test('voucher: exact-amount finalize, default and supplied refs', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'voucher', amount_cents: o.total_cents }],
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.change_cents, 0);
    assert.equal(fin.data.order.status, 'paid');
    assert.equal(fin.data.order.payments.length, 1);
    assert.equal(fin.data.order.payments[0].method, 'voucher');
    assert.equal(fin.data.order.payments[0].change_cents, 0);
    assert.equal(fin.data.order.payments[0].ref, 'VOUCHER'); // default ref
    // a supplied ref is preserved
    const r2 = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const fin2 = await cashier('POST', `/api/pos/orders/${r2.data.order.id}/finalize`, {
      payments: [{ method: 'voucher', amount_cents: r2.data.order.total_cents, ref: 'V-123' }],
    });
    assert.equal(fin2.status, 200);
    assert.equal(fin2.data.order.payments[0].ref, 'V-123');
  });

  await t.test('split voucher + cash: change comes off the cash row only', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order; // 3182
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [
        { method: 'voucher', amount_cents: 1000 },
        { method: 'cash', amount_cents: o.total_cents - 1000 + 300 },
      ],
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.change_cents, 300);
    const pays = fin.data.order.payments;
    assert.equal(pays.length, 2);
    assert.equal(pays[0].method, 'voucher');
    assert.equal(pays[0].change_cents, 0); // never on a non-change tender
    assert.equal(pays[1].method, 'cash');
    assert.equal(pays[1].change_cents, 300);
    // net of change equals the order total
    assert.equal(pays.reduce((a, p) => a + p.amount_cents - p.change_cents, 0), o.total_cents);
  });

  await t.test('voucher over-tender (change without a change-bearing tender) is rejected', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'voucher', amount_cents: o.total_cents + 500 }],
    });
    assert.equal(fin.status, 400);
    assert.equal(fin.data.error, 'bad_tender');
    const after = await cashier('GET', `/api/pos/orders/${o.id}`);
    assert.equal(after.data.order.status, 'open');
    assert.equal(after.data.order.payments.length, 0);
  });

  await t.test('unknown/hostile methods rejected before any write; table intact', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    for (const method of ['bitcoin', "cash'; DROP TABLE payments;--", 'CASH', ' cash', { toString: 1 }, null]) {
      const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
        payments: [{ method, amount_cents: o.total_cents }],
      });
      assert.equal(fin.status, 400, `method ${JSON.stringify(method)} rejected`);
      assert.equal(fin.data.error, 'bad_method');
      // error message names valid methods only, never echoes attacker input
      assert.ok(!fin.data.message.includes('DROP'), 'no attacker echo');
    }
    // payments table survived and the order took no rows
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(o.id).n, 0);
    const after = await cashier('GET', `/api/pos/orders/${o.id}`);
    assert.equal(after.data.order.status, 'open');
  });

  await t.test('bad amounts rejected: zero, negative, float, huge float', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    for (const amount_cents of [0, -100, 10.5, 1e15 + 0.5, null, 'abc']) {
      const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
        payments: [{ method: 'voucher', amount_cents }],
      });
      assert.equal(fin.status, 400, `amount ${amount_cents} rejected`);
      assert.equal(fin.data.error, 'bad_amount');
    }
    assert.equal((await cashier('GET', `/api/pos/orders/${o.id}`)).data.order.payments.length, 0);
  });

  await t.test('over-long ref is truncated to 64 chars, never stored raw', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'voucher', amount_cents: o.total_cents, ref: 'X'.repeat(10000) }],
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.order.payments[0].ref.length, 64);
  });

  await t.test('refund of a voucher-paid order writes a negative voucher row', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'voucher', amount_cents: o.total_cents }],
    });
    assert.equal(fin.status, 200);
    const ref = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: { username: 'manager', password: 'manager' },
    });
    assert.equal(ref.status, 200);
    const neg = ref.data.order.payments.filter((p) => p.amount_cents < 0);
    assert.equal(neg.length, 1);
    assert.equal(neg[0].method, 'voucher');
    assert.equal(neg[0].amount_cents, -o.total_cents);
    assert.equal(neg[0].ref, 'REFUND');
    const net = ref.data.order.payments.reduce((a, p) => a + p.amount_cents - p.change_cents, 0);
    assert.equal(net, 0);
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

  await t.test('renewal consumes member_id column — description is display-only', async () => {
    const r0 = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: memExp.id, qty: 1 }],
      customer: { name: 'Col Umn', email: 'col@example.com' },
    });
    const fin0 = await cashier('POST', `/api/pos/orders/${r0.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: r0.data.order.total_cents }],
    });
    const m = fin0.data.members[0];

    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: memExp.id, qty: 1, member: { member_id: m.id } }],
    });
    const o = r.data.order;
    assert.equal(o.lines[0].member_id, m.id); // structured column written at line add
    // garble the display text — finalize must not care what it says
    db.prepare("UPDATE order_lines SET description = 'Garbage text' WHERE id = ?")
      .run(o.lines[0].id);
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: o.total_cents }],
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.members[0].id, m.id); // same member renewed
  });

  await t.test('new member from member_intent: line email wins; line gets stamped', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: memExp.id, qty: 1, member: { name: 'Gift Kid', email: 'kid@example.com' } },
      ],
      customer: { name: 'Buyer One', email: 'buyer1@example.com' },
    });
    const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: r.data.order.total_cents }],
    });
    assert.equal(fin.status, 200);
    const m = fin.data.members[0];
    assert.equal(m.name, 'Gift Kid');
    assert.equal(m.email, 'kid@example.com'); // NOT the order email
    // finalize stamped the minted member back onto the line (joinable for reports)
    const detail = await cashier('GET', `/api/pos/orders/${r.data.order.id}`);
    assert.equal(detail.data.order.lines[0].member_id, m.id);
  });

  await t.test('intent with empty email suppresses the order-email fallback', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: memExp.id, qty: 1, member: { name: 'No Mail', email: '' } }],
      customer: { name: 'Buyer Two', email: 'buyer2@example.com' },
    });
    const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: r.data.order.total_cents }],
    });
    const m = fin.data.members[0];
    assert.equal(m.name, 'No Mail');
    assert.equal(m.email, ''); // parity with the legacy "(for Name)" no-email path
  });

  await t.test('regression: product named with the legacy suffix cannot hijack renewals', async () => {
    const before = db.prepare('SELECT name FROM products WHERE id = ?').get(memExp.id).name;
    db.prepare("UPDATE products SET name = 'Trap (renewal #1)' WHERE id = ?").run(memExp.id);
    try {
      const r = await cashier('POST', '/api/pos/orders', {
        lines: [{ product_id: memExp.id, qty: 1 }],
        customer: { name: 'Fresh Face', email: 'fresh@example.com' },
      });
      const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
        payments: [{ method: 'card_sim', amount_cents: r.data.order.total_cents }],
      });
      assert.equal(fin.status, 200);
      const m = fin.data.members[0];
      assert.notEqual(m.id, 1); // did NOT renew member 1
      assert.equal(m.email, 'fresh@example.com'); // fresh member from the order email
    } finally {
      db.prepare('UPDATE products SET name = ? WHERE id = ?').run(before, memExp.id);
    }
  });

  await t.test('qty=2 membership line posts TWO members, one year each', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: memExp.id, qty: 2, member: { name: 'Twice Over', email: 'twice@example.com' } },
      ],
    });
    const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: r.data.order.total_cents }],
    });
    // two memberships paid for = two memberships delivered, never one with double
    // duration (which would hand the second guest a copy of the first one's pass)
    assert.equal(fin.data.members.length, 2);
    assert.notEqual(fin.data.members[1].id, fin.data.members[0].id);
    assert.notEqual(fin.data.members[1].member_no, fin.data.members[0].member_no);
    assert.notEqual(fin.data.members[1].pass_code, fin.data.members[0].pass_code);
    for (const m of fin.data.members) {
      assert.equal(m.email, 'twice@example.com'); // the email survives the create path
      const gainDays = (Date.parse(m.expires_at) - Date.now()) / (24 * 3600 * 1000);
      assert.ok(gainDays > 364 && gainDays < 366, `expected ~365 days, got ${gainDays}`);
    }
    const rows = db
      .prepare("SELECT * FROM members WHERE lower(email) = 'twice@example.com' ORDER BY id")
      .all();
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((m) => m.status === 'active').length, 2);
  });

  await t.test('two named members on one household email each get their own membership', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: memExp.id, qty: 1, member: { name: 'Bob Household', email: 'house@example.com' } },
        { product_id: memExp.id, qty: 1, member: { name: 'Alice Household', email: 'house@example.com' } },
      ],
    });
    const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: r.data.order.total_cents }],
    });
    assert.equal(fin.status, 200);
    const names = fin.data.members.map((m) => m.name).sort();
    assert.deepEqual(names, ['Alice Household', 'Bob Household']);
    const rows = db
      .prepare("SELECT * FROM members WHERE lower(email) = 'house@example.com' ORDER BY id")
      .all();
    assert.equal(rows.length, 2, 'Alice must not be swallowed by Bob’s record');
    assert.deepEqual(rows.map((m) => m.name).sort(), ['Alice Household', 'Bob Household']);
    for (const m of rows) {
      const days = (Date.parse(m.expires_at) - Date.now()) / (24 * 3600 * 1000);
      assert.ok(days > 364 && days < 366, `one year each, got ${days}`);
    }
  });

  await t.test('a bare line (no member named) still renews the buyer’s own membership', async () => {
    const first = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: memExp.id, qty: 1 }],
      customer: { name: 'Solo Buyer', email: 'solo@example.com' },
    });
    const finA = await cashier('POST', `/api/pos/orders/${first.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: first.data.order.total_cents }],
    });
    const second = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: memExp.id, qty: 1 }],
      customer: { name: 'Solo Buyer', email: 'solo@example.com' },
    });
    const finB = await cashier('POST', `/api/pos/orders/${second.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: second.data.order.total_cents }],
    });
    assert.equal(finB.data.members[0].id, finA.data.members[0].id);
    const gain =
      (Date.parse(finB.data.members[0].expires_at) - Date.parse(finA.data.members[0].expires_at))
      / (24 * 3600 * 1000);
    assert.ok(gain > 364 && gain < 366, `renewal extends by a year, got ${gain}`);
  });

  await t.test('member_intent is server-written only; oversized names are capped', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        {
          product_id: memExp.id,
          qty: 1,
          member_intent: '{"name":"Mallory","email":"mallory@example.com"}', // must be ignored
          member: { name: 'A'.repeat(10000), email: 'big@example.com' },
        },
      ],
      customer: { name: 'Buyer Three', email: 'buyer3@example.com' },
    });
    assert.equal(r.status, 200);
    const line = db
      .prepare('SELECT member_intent FROM order_lines WHERE order_id = ?')
      .get(r.data.order.id);
    const intent = JSON.parse(line.member_intent);
    assert.equal(intent.email, 'big@example.com'); // not the injected JSON
    assert.equal(intent.name.length, 200); // capped
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

    // no approver credential → refused, regardless of role
    const deny = await cashier('POST', `/api/pos/orders/${o.id}/refund`, {});
    assert.equal(deny.status, 403);
    assert.equal(deny.data.error, 'approval_required');
    const denyMgr = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {});
    assert.equal(denyMgr.status, 403);

    // manager refunds (their own credential as approver)
    const ref = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: { username: 'manager', password: 'manager' },
    });
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

    // refund audit row carries both the session user and the approver
    const auditRow = db
      .prepare("SELECT * FROM audit_log WHERE action = 'pos.order.refund' ORDER BY id DESC LIMIT 1")
      .get();
    const detail = JSON.parse(auditRow.detail);
    assert.equal(detail.order_id, o.id);
    const mgrId = db.prepare("SELECT id FROM users WHERE username = 'manager'").get().id;
    assert.equal(detail.approved_by, mgrId);
    assert.equal(auditRow.user_id, mgrId);

    // cannot refund twice
    const again = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: { username: 'manager', password: 'manager' },
    });
    assert.equal(again.status, 409);
  });

  await t.test('void: manager approval, open orders only, cannot finalize after', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    const approver = { username: 'manager', password: 'manager' };
    assert.equal((await cashier('POST', `/api/pos/orders/${o.id}/void`, {})).status, 403);
    // cashier session + a manager's credential succeeds, audit attributes both
    const v = await cashier('POST', `/api/pos/orders/${o.id}/void`, { approver });
    assert.equal(v.status, 200);
    assert.equal(v.data.order.status, 'void');
    const voidAudit = db
      .prepare("SELECT * FROM audit_log WHERE action = 'pos.order.void' ORDER BY id DESC LIMIT 1")
      .get();
    const vd = JSON.parse(voidAudit.detail);
    assert.equal(vd.approved_by, db.prepare("SELECT id FROM users WHERE username = 'manager'").get().id);
    assert.equal(voidAudit.user_id, db.prepare("SELECT id FROM users WHERE username = 'cashier'").get().id);
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: 99999 }],
    });
    assert.equal(fin.status, 409);
    const rv = await mgr('POST', `/api/pos/orders/${o.id}/void`, { approver });
    assert.equal(rv.status, 409); // not voidable twice
  });

  await t.test('approver must be an active manager/admin with the right password', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    // gate role cannot approve, generic 403 either way
    let deny = await cashier('POST', `/api/pos/orders/${o.id}/void`, {
      approver: { username: 'gate', password: 'gate' },
    });
    assert.equal(deny.status, 403);
    assert.equal(deny.data.error, 'approval_required');
    // wrong password: same generic 403, no oracle
    deny = await cashier('POST', `/api/pos/orders/${o.id}/void`, {
      approver: { username: 'manager', password: 'wrong' },
    });
    assert.equal(deny.status, 403);
    assert.equal(deny.data.error, 'approval_required');
    assert.equal((await cashier('GET', `/api/pos/orders/${o.id}`)).data.order.status, 'open');
  });

  await t.test('approver attempts count toward the approver account lockout', async () => {
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const o = r.data.order;
    // 4 more wrong attempts (one spent in the previous subtest) reach the 5-failure lock
    for (let i = 0; i < 4; i++) {
      const deny = await cashier('POST', `/api/pos/orders/${o.id}/void`, {
        approver: { username: 'manager', password: 'still-wrong' },
      });
      assert.equal(deny.status, 403);
    }
    const locked = db.prepare("SELECT locked_until FROM users WHERE username = 'manager'").get();
    assert.ok(locked.locked_until, 'manager account should be locked');
    // even the correct approver password fails while locked
    const stillDenied = await cashier('POST', `/api/pos/orders/${o.id}/void`, {
      approver: { username: 'manager', password: 'manager' },
    });
    assert.equal(stillDenied.status, 403);
    // unlock and the approval works again
    db.prepare("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE username = 'manager'").run();
    const ok = await cashier('POST', `/api/pos/orders/${o.id}/void`, {
      approver: { username: 'manager', password: 'manager' },
    });
    assert.equal(ok.status, 200);
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

test('pos: member-order-lines migration backfills legacy descriptions', async (t) => {
  // Stage a pre-change DB: apply every migration EXCEPT member-order-lines, write
  // rows in the legacy text encoding, then boot the app so the real migration runs.
  const dbPath = tempDb();
  const migrationsDir = path.join(__dirname, '..', 'server', 'migrations');
  const partialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-mig-'));
  for (const f of fs.readdirSync(migrationsDir)) {
    if (!f.includes('member-order-lines')) {
      fs.copyFileSync(path.join(migrationsDir, f), path.join(partialDir, f));
    }
  }
  const staged = openDb(dbPath);
  migrate(staged, partialDir);
  seedDemo(staged); // seed now, on the OLD schema, so createApp skips it later
  const memProdId = staged.prepare("SELECT id FROM products WHERE sku = 'MEM-EXP'").get().id;
  staged.exec(`
    INSERT INTO products (id, sku, name, kind, price_cents, tax_group_id)
      VALUES (501, 'LEG-TIX', 'Trap Ticket (renewal #507)', 'ticket', 1000, 1);
    INSERT INTO members (id, member_no, name, email, program_id, pass_code, joined_at, expires_at)
      VALUES (507, 'GM-LEGACY1', 'Renata Renewal', 'renata@example.com', 1,
              'M-LEGACY0001', '2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO orders (id, channel, status, subtotal_cents, total_cents, created_at, paid_at)
      VALUES (9000, 'pos', 'paid', 49500, 49500, '2025-06-01T00:00:00.000Z', '2025-06-01T00:00:01.000Z');
    INSERT INTO order_lines (id, order_id, product_id, description, qty, unit_price_cents, line_total_cents)
      VALUES
      (9001, 9000, ${memProdId}, 'Explorer Annual Membership (renewal #507)', 1, 9900, 9900),
      (9002, 9000, ${memProdId}, 'Explorer Annual Membership (renewal #999)', 1, 9900, 9900),
      (9003, 9000, ${memProdId}, 'Explorer Annual Membership (for Pat Smith <pat@example.com>)', 1, 9900, 9900),
      (9004, 9000, ${memProdId}, 'Explorer Annual Membership (for Pat Smith)', 1, 9900, 9900),
      (9005, 9000, ${memProdId}, 'Explorer Annual Membership', 1, 9900, 9900),
      (9006, 9000, 501, 'Trap Ticket (renewal #507)', 1, 1000, 1000);
    INSERT INTO orders (id, channel, status, subtotal_cents, total_cents, created_at)
      VALUES (9010, 'pos', 'open', 9900, 9900, '2025-06-02T00:00:00.000Z');
    INSERT INTO order_lines (id, order_id, product_id, description, qty, unit_price_cents, line_total_cents)
      VALUES (9011, 9010, ${memProdId}, 'Explorer Annual Membership (renewal #507)', 1, 9900, 9900);
  `);
  staged.close();

  const { server, db, ctx } = createApp(dbPath); // applies the member-order-lines migration
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const get = (id) =>
    db.prepare('SELECT member_id, member_intent FROM order_lines WHERE id = ?').get(id);
  assert.equal(get(9001).member_id, 507); // renewal -> member_id
  assert.deepEqual({ ...get(9002) }, { member_id: null, member_intent: null }); // no member 999
  assert.equal(get(9003).member_id, null);
  assert.deepEqual(JSON.parse(get(9003).member_intent), {
    name: 'Pat Smith', email: 'pat@example.com',
  });
  assert.deepEqual(JSON.parse(get(9004).member_intent), { name: 'Pat Smith', email: '' });
  assert.deepEqual({ ...get(9005) }, { member_id: null, member_intent: null }); // plain: NULL, never guess
  assert.deepEqual({ ...get(9006) }, { member_id: null, member_intent: null }); // non-membership untouched

  // Open-order upgrade path: a pre-migration open renewal finalizes with the new
  // code and still renews the right member (via the backfilled column).
  const result = ctx.modules.pos.finalizeOrder(db, ctx, 9010, [
    { method: 'card_sim', amount_cents: 9900 }, // card: no drawer needed for this legacy order
  ]);
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].id, 507);
  assert.ok(Date.parse(result.members[0].expires_at) > Date.parse('2026-01-01T00:00:00.000Z'));
});

test('migration 006: payments recreate preserves rows, drops the method enum CHECK', () => {
  const { openDb, migrate } = require('../server/core/db');
  const dbPath = tempDb();
  const db = openDb(dbPath);
  const dir = path.join(__dirname, '..', 'server', 'migrations');
  // Apply only the pre-tender migrations, exactly as the runner would.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (f >= '006') continue;
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run(f, new Date().toISOString());
  }
  // A paid order with old-CHECK payments, as a pre-migration DB would hold.
  db.prepare(
    `INSERT INTO orders (id, channel, status, subtotal_cents, discount_cents, tax_cents,
       total_cents, created_at) VALUES (1, 'pos', 'paid', 5000, 0, 0, 5000, ?)`
  ).run(new Date().toISOString());
  db.prepare(
    `INSERT INTO payments (id, order_id, method, amount_cents, change_cents, ref, created_at)
     VALUES (1, 1, 'cash', 3000, 500, '', ?), (2, 1, 'card_sim', 2500, 0, 'AUTH-ABC123', ?)`
  ).run(new Date().toISOString(), new Date().toISOString());
  assert.throws(() => db.prepare(
    "INSERT INTO payments (order_id, method, amount_cents, created_at) VALUES (1, 'voucher', 1, '')"
  ).run(), /CHECK/, 'old schema still rejects voucher');

  migrate(db, dir); // applies 006+ only

  const rows = db.prepare('SELECT * FROM payments ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.id, r.order_id, r.method, r.amount_cents, r.change_cents, r.ref]),
    [[1, 1, 'cash', 3000, 500, ''], [2, 1, 'card_sim', 2500, 0, 'AUTH-ABC123']],
    'ids and values preserved across the recreate'
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'FKs clean');
  // registry methods now insert; empty method still blocked by the new CHECK
  db.prepare(
    `INSERT INTO payments (order_id, method, amount_cents, created_at) VALUES (1, 'voucher', 100, ?)`
  ).run(new Date().toISOString());
  assert.throws(() => db.prepare(
    "INSERT INTO payments (order_id, method, amount_cents, created_at) VALUES (1, '', 1, '')"
  ).run(), /CHECK/);
  // the index survived under its original name
  assert.ok(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_payments_order'"
  ).get());
  db.close();
});

test('pos: guest checkout cannot smuggle a tender — server builds card_sim itself', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());

  const adult = db.prepare("SELECT * FROM products WHERE sku = 'ADULT'").get();
  const res = await fetch(base + '/api/store/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Sneaky Guest', email: 'sneaky@example.com' },
      lines: [{ product_id: adult.id, qty: 1 }],
      card: { number: '4242 4242 4242 4242' },
      // injected fields a guest must never control:
      payments: [{ method: 'voucher', amount_cents: 1 }],
      method: 'voucher',
      amount_cents: 1,
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const orderId = db
    .prepare('SELECT id, status, total_cents FROM orders WHERE confirmation = ?')
    .get(data.confirmation);
  assert.equal(orderId.status, 'paid');
  const pays = db.prepare('SELECT * FROM payments WHERE order_id = ?').all(orderId.id);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].method, 'card_sim'); // injected voucher ignored
  assert.equal(pays[0].amount_cents, orderId.total_cents); // full total, not 1 cent
  assert.match(pays[0].ref, /^CARD-4242$/);
  // guest order view exposes no payments/tender data
  assert.equal(data.order.payments, undefined);
});

test('pos: a timed-entry ticket is always valid on the day of its session', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });

  const plntm = db.prepare("SELECT * FROM products WHERE sku = 'PLNTM'").get();
  // a season schedule opened for advance sale further out than validity_days:
  // the ticket must still be alive when the guest turns up (admissions denies on
  // valid_to before it ever considers the session window)
  db.prepare('UPDATE products SET validity_days = 1 WHERE id = ?').run(plntm.id);
  const startsAt = new Date(Date.now() + 45 * 24 * 3600 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 45 * 24 * 3600 * 1000 + 3600_000).toISOString();
  const far = Number(
    db.prepare(
      'INSERT INTO event_sessions (event_id, starts_at, ends_at, capacity) VALUES (?, ?, ?, 20)'
    ).run(plntm.event_id, startsAt, endsAt).lastInsertRowid
  );

  const r = await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: plntm.id, qty: 1, event_session_id: far }],
  });
  assert.equal(r.status, 200);
  const fin = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
    payments: [{ method: 'card_sim', amount_cents: r.data.order.total_cents }],
  });
  assert.equal(fin.status, 200);
  const ticket = fin.data.tickets[0];
  assert.ok(
    Date.parse(ticket.valid_to) >= Date.parse(endsAt),
    `ticket expires ${ticket.valid_to}, before its own session ends ${endsAt}`
  );

  // an untimed line keeps the plain purchase-date window
  const adult = db.prepare("SELECT * FROM products WHERE sku = 'ADULT'").get();
  db.prepare('UPDATE products SET validity_days = 2 WHERE id = ?').run(adult.id);
  const o2 = await cashier('POST', '/api/pos/orders', { lines: [{ product_id: adult.id, qty: 1 }] });
  const fin2 = await cashier('POST', `/api/pos/orders/${o2.data.order.id}/finalize`, {
    payments: [{ method: 'card_sim', amount_cents: o2.data.order.total_cents }],
  });
  const days =
    (Date.parse(fin2.data.tickets[0].valid_to) - Date.now()) / (24 * 3600 * 1000);
  assert.ok(days > 1.9 && days < 2.1, `expected the 2-day window, got ${days}`);
});

test('pos: manager approvals are throttled on failures only', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  const adult = db.prepare("SELECT * FROM products WHERE sku = 'ADULT'").get();
  const approver = { username: 'manager', password: 'manager' };

  // a manager clearing a long queue must not run out of approvals mid-shift
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    const o = await cashier('POST', '/api/pos/orders', { lines: [{ product_id: adult.id, qty: 1 }] });
    const r = await cashier('POST', `/api/pos/orders/${o.data.order.id}/void`, { approver });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, Array(25).fill(200), 'successful approvals cost no budget');

  // …while wrong credentials still burn it: 20 failures, then the door shuts
  const fails = [];
  for (let i = 0; i < 21; i++) {
    const o = await cashier('POST', '/api/pos/orders', { lines: [{ product_id: adult.id, qty: 1 }] });
    const r = await cashier('POST', `/api/pos/orders/${o.data.order.id}/void`, {
      approver: { username: `ghost-${i}`, password: 'nope' },
    });
    fails.push(r.status);
  }
  assert.deepEqual(fails.slice(0, 20), Array(20).fill(403));
  assert.equal(fails[20], 429);
});

test('pos: approval audit records the real client ip behind a trusted proxy', async (t) => {
  const dbPath = tempDb();
  const { server, db } = createApp(dbPath, {
    env: { ...process.env, OWLPOS_TRUST_PROXY: '1' },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
    body: JSON.stringify({ username: 'cashier', password: 'cashier' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const res = await fetch(base + '/api/pos/orders/999999/void', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': '203.0.113.77' },
    body: JSON.stringify({ approver: { username: 'manager', password: 'wrong' } }),
  });
  assert.equal(res.status, 403);
  const row = db
    .prepare("SELECT detail FROM audit_log WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(JSON.parse(row.detail).ip, '203.0.113.77', 'not the proxy address');
});
