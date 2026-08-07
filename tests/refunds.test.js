'use strict';
// partial-refunds-exchanges: per-line refunds, session exchanges, and their
// reporting/journal treatment — including the security battery (authz,
// over-refund, IDOR line ids, capacity laundering, audit trail).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const eventsMod = require('../server/modules/events');

const APPROVER = { username: 'manager', password: 'manager' };

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer() {
  const app = createApp(tempDb());
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base };
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

async function login(base, username) {
  const c = client(base);
  const r = await c('POST', '/api/auth/login', { username, password: username });
  assert.equal(r.status, 200, `login as ${username}`);
  return c;
}

// build + pay a POS order, returns the paid order detail
async function paidOrder(cashier, lines, payments, extra = {}) {
  const r = await cashier('POST', '/api/pos/orders', { lines, ...extra });
  assert.equal(r.status, 200);
  const o = r.data.order;
  const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
    payments: payments || [{ method: 'cash', amount_cents: o.total_cents }],
  });
  assert.equal(fin.status, 200);
  return fin.data.order;
}

const sumNegByMethod = (db, orderId) => Object.fromEntries(
  db.prepare(
    `SELECT method, -SUM(amount_cents) AS refunded FROM payments
     WHERE order_id = ? AND amount_cents < 0 GROUP BY method`
  ).all(orderId).map((r) => [r.method, r.refunded])
);

test('pos: partial refunds — money, tickets, capacity, status flow', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 50000 })).status, 200);
  const mgr = await login(base, 'manager');

  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');
  const plntm = sell.find((p) => p.sku === 'PLNTM');
  const sessions = (await (await fetch(base + `/api/events/${plntm.event_id}/sessions`)).json()).sessions;

  await t.test('fresh schema: FK integrity intact after the orders rebuild', () => {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // the widened CHECK accepts the new status
    db.exec("INSERT INTO orders (channel, status, created_at) VALUES ('pos','partial_refund','2020-01-01')");
    db.exec("DELETE FROM orders WHERE status = 'partial_refund' AND created_at = '2020-01-01'");
  });

  const s0 = sessions[0];
  const o1 = await paidOrder(cashier, [
    { product_id: adult.id, qty: 3 },
    { product_id: plntm.id, qty: 2, event_session_id: s0.id },
  ]);
  const adultLine = o1.lines.find((l) => l.sku === 'ADULT');
  const plntmLine = o1.lines.find((l) => l.sku === 'PLNTM');
  const soldAfterSale = eventsMod.getSession(db, s0.id).sold;

  await t.test('refund 1 of 3: partial_refund status, exact money, one ticket void, siblings scan ok', async () => {
    const r = await mgr('POST', `/api/pos/orders/${o1.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: adultLine.id, qty: 1 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.status, 'partial_refund');
    assert.equal(r.data.order.refunded_at, null);
    // 1/3 of the line: gross 2995, tax round(562/3)=187
    assert.equal(r.data.refund.total_cents, 2995 + 187);
    const neg = r.data.order.payments.filter((p) => p.amount_cents < 0);
    assert.equal(neg.length, 1);
    assert.equal(neg[0].amount_cents, -(2995 + 187));
    assert.equal(neg[0].ref, 'REFUND');
    // exactly one adult ticket voided, deterministically the lowest id
    const adultTickets = r.data.order.tickets.filter((tk) => tk.order_line_id === adultLine.id);
    assert.deepEqual(adultTickets.map((tk) => tk.status), ['void', 'valid', 'valid']);
    assert.equal(r.data.voided_tickets, 1);
    // per-line progress is visible on the detail
    assert.equal(r.data.order.lines.find((l) => l.id === adultLine.id).refunded_qty, 1);
    // capacity untouched (adult line has no session)
    assert.equal(eventsMod.getSession(db, s0.id).sold, soldAfterSale);
    // gate: voided ticket denied 'void', sibling still admits
    const scanVoid = await mgr('POST', '/api/admissions/scan', { code: adultTickets[0].code });
    assert.equal(scanVoid.data.result, 'denied');
    assert.equal(scanVoid.data.reason, 'void');
    const scanOk = await mgr('POST', '/api/admissions/scan', { code: adultTickets[1].code });
    assert.equal(scanOk.data.result, 'ok');
    // refund event recorded at line granularity
    const rl = db.prepare(
      'SELECT * FROM refund_lines WHERE order_line_id = ?'
    ).all(adultLine.id);
    assert.equal(rl.length, 1);
    assert.deepEqual(
      { qty: rl[0].qty, gross: rl[0].gross_cents, total: rl[0].total_cents },
      { qty: 1, gross: 2995, total: 3182 }
    );
  });

  await t.test('session line partial refund releases exactly q seats', async () => {
    const r = await mgr('POST', `/api/pos/orders/${o1.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: plntmLine.id, qty: 1 }],
    });
    assert.equal(r.status, 200);
    assert.equal(eventsMod.getSession(db, s0.id).sold, soldAfterSale - 1);
    // plntm: gross 900, tax round(113/2)=57
    assert.equal(r.data.refund.total_cents, 900 + 57);
    const plTickets = r.data.order.tickets.filter((tk) => tk.order_line_id === plntmLine.id);
    assert.deepEqual(plTickets.map((tk) => tk.status), ['void', 'valid']);
  });

  await t.test('empty body refunds the remainder: -> refunded, payments net zero, third refund 409', async () => {
    const r = await mgr('POST', `/api/pos/orders/${o1.id}/refund`, { approver: APPROVER });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.status, 'refunded');
    assert.ok(r.data.order.refunded_at);
    assert.ok(r.data.order.tickets.every((tk) => tk.status === 'void'));
    assert.ok(r.data.order.lines.every((l) => l.refunded_qty === l.qty));
    assert.equal(eventsMod.getSession(db, s0.id).sold, soldAfterSale - 2);
    // cumulative refunds equal the original net exactly
    const net = r.data.order.payments.reduce((a, p) => a + p.amount_cents - p.change_cents, 0);
    assert.equal(net, 0);
    // per line: SUM(refund_lines.qty) == refunded_qty, amounts sum to the line total
    for (const l of r.data.order.lines) {
      const agg = db.prepare(
        'SELECT COALESCE(SUM(qty),0) AS q, COALESCE(SUM(total_cents),0) AS total FROM refund_lines WHERE order_line_id = ?'
      ).get(l.id);
      assert.equal(agg.q, l.qty);
      assert.equal(agg.total, l.line_total_cents);
    }
    const again = await mgr('POST', `/api/pos/orders/${o1.id}/refund`, { approver: APPROVER });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'not_refundable');
  });

  await t.test('rounding: discounted 3-qty line refunded 1+1+1 sums exactly to the line total', async () => {
    const o = await paidOrder(cashier, [{ product_id: adult.id, qty: 3 }], null,
      { discount_code: 'SAVE10' });
    const line = o.lines[0];
    assert.ok(line.discount_cents > 0);
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      const r = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
        approver: APPROVER, lines: [{ order_line_id: line.id, qty: 1 }],
      });
      assert.equal(r.status, 200);
      sum += r.data.refund.total_cents;
    }
    assert.equal(sum, line.line_total_cents);
    const done = (await cashier('GET', `/api/pos/orders/${o.id}`)).data.order;
    assert.equal(done.status, 'refunded');
    // GL slices also sum exactly per component
    const agg = db.prepare(
      `SELECT SUM(gross_cents) AS g, SUM(discount_cents) AS d, SUM(tax_cents) AS t
       FROM refund_lines WHERE order_line_id = ?`
    ).get(line.id);
    assert.equal(agg.g, line.qty * line.unit_price_cents);
    assert.equal(agg.d, line.discount_cents);
    assert.equal(agg.t, line.tax_cents);
  });

  await t.test('split tender: refunds allocate per method and never exceed a method\'s net', async () => {
    const r0 = await cashier('POST', '/api/pos/orders', { lines: [{ product_id: adult.id, qty: 3 }] });
    const total = r0.data.order.total_cents; // 11460
    const o = await paidOrder(cashier, [{ product_id: adult.id, qty: 3 }], [
      { method: 'card_sim', amount_cents: 2000 },
      { method: 'cash', amount_cents: total - 2000 },
    ]);
    const line = o.lines[0];
    const r1 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: line.id, qty: 1 }],
    });
    assert.equal(r1.status, 200);
    let refunded = sumNegByMethod(db, o.id);
    assert.ok((refunded.card_sim || 0) <= 2000);
    assert.ok((refunded.cash || 0) <= total - 2000);
    assert.equal((refunded.card_sim || 0) + (refunded.cash || 0), r1.data.refund.total_cents);
    const r2 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER });
    assert.equal(r2.status, 200);
    refunded = sumNegByMethod(db, o.id);
    // fully refunded: per-method refunds equal per-method nets exactly
    assert.equal(refunded.card_sim, 2000);
    assert.equal(refunded.cash, total - 2000);
  });

  await t.test('used tickets: explicit selection refuses (409), full refund overrides', async () => {
    const o = await paidOrder(cashier, [{ product_id: adult.id, qty: 1 }]);
    const scan = await mgr('POST', '/api/admissions/scan', { code: o.tickets[0].code });
    assert.equal(scan.data.result, 'ok'); // ticket now used/exhausted
    const denied = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: o.lines[0].id, qty: 1 }],
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.data.error, 'tickets_used');
    // state unchanged by the refusal
    assert.equal((await cashier('GET', `/api/pos/orders/${o.id}`)).data.order.status, 'paid');
    // manager full refund still possible (legacy semantics)
    const full = await mgr('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER });
    assert.equal(full.status, 200);
    assert.equal(full.data.order.status, 'refunded');
    assert.equal(full.data.order.tickets[0].status, 'void');
  });

  await t.test('audit: every refund writes a pos.order.refund row with approver + lines', () => {
    const rows = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'pos.order.refund' ORDER BY id DESC LIMIT 1"
    ).all();
    const d = JSON.parse(rows[0].detail);
    assert.ok(Number.isInteger(d.order_id));
    assert.ok(Array.isArray(d.lines) && d.lines.length >= 1);
    assert.ok(Number.isInteger(d.refund_cents));
    const mgrId = db.prepare("SELECT id FROM users WHERE username = 'manager'").get().id;
    assert.equal(d.approved_by, mgrId);
    // one audit row per refund event
    const nAudits = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pos.order.refund'").get().n;
    const nRefunds = db.prepare('SELECT COUNT(*) AS n FROM refunds').get().n;
    assert.equal(nAudits, nRefunds);
  });
});

test('pos: refund validation battery — over-refund, IDOR, bad payloads', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 50000 })).status, 200);
  const mgr = await login(base, 'manager');
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');
  const park = sell.find((p) => p.sku === 'PARK');

  // two lines so the order stays partial_refund while one line is exhausted
  const o = await paidOrder(cashier, [
    { product_id: adult.id, qty: 2 },
    { product_id: park.id, qty: 1 },
  ]);
  const line = o.lines.find((l) => l.sku === 'ADULT');
  const parkLine = o.lines.find((l) => l.sku === 'PARK');
  const other = await paidOrder(cashier, [{ product_id: adult.id, qty: 1 }]);

  const attempt = (lines) =>
    mgr('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER, lines });

  await t.test('qty: 0, negative, float, string, NaN, overflow all rejected 400', async () => {
    for (const qty of [0, -1, 2.5, '1', null, 1e9, 3]) {
      const r = await attempt([{ order_line_id: line.id, qty }]);
      assert.equal(r.status, 400, `qty ${JSON.stringify(qty)} rejected`);
      assert.equal(r.data.error, 'bad_qty');
    }
  });

  await t.test('IDOR: a line id from a different order is rejected, no state change', async () => {
    const r = await attempt([{ order_line_id: other.lines[0].id, qty: 1 }]);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_line');
    const rs = await attempt([{ order_line_id: 999999, qty: 1 }]);
    assert.equal(rs.status, 400);
    const rf = await attempt([{ order_line_id: '1', qty: 1 }]); // string id: no coercion
    assert.equal(rf.status, 400);
    assert.equal((await cashier('GET', `/api/pos/orders/${other.id}`)).data.order.status, 'paid');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refunds').get().n, 0);
  });

  await t.test('duplicates, non-array lines, oversize array rejected', async () => {
    let r = await attempt([{ order_line_id: line.id, qty: 1 }, { order_line_id: line.id, qty: 1 }]);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_line');
    r = await mgr('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER, lines: 'all' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_lines');
    r = await attempt(Array.from({ length: 201 }, (_, i) => ({ order_line_id: i + 1, qty: 1 })));
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_lines');
  });

  await t.test('over-refund: second refund bounded by refunded_qty', async () => {
    assert.equal((await attempt([{ order_line_id: line.id, qty: 2 }])).status, 200);
    // order is partial_refund (park line live) but the adult line is exhausted
    const again = await attempt([{ order_line_id: line.id, qty: 1 }]);
    assert.equal(again.status, 400); // remaining is 0
    assert.equal(again.data.error, 'bad_qty');
    // money did not move twice: only the adult line's total came back
    const net = db.prepare(
      'SELECT SUM(amount_cents - change_cents) AS s FROM payments WHERE order_id = ?'
    ).get(o.id).s;
    assert.equal(net, parkLine.line_total_cents);
    // exhausting the last line via the qty bound flips the order to refunded
    assert.equal((await attempt([{ order_line_id: parkLine.id, qty: 1 }])).status, 200);
    const done = (await cashier('GET', `/api/pos/orders/${o.id}`)).data.order;
    assert.equal(done.status, 'refunded');
    const fullyDone = await attempt([{ order_line_id: parkLine.id, qty: 1 }]);
    assert.equal(fullyDone.status, 409);
    assert.equal(fullyDone.data.error, 'not_refundable');
  });

});

test('pos: cancelled-session tickets stay refundable per line', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 50000 })).status, 200);
  const mgr = await login(base, 'manager');
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');
  const plntm = sell.find((p) => p.sku === 'PLNTM');
  const sessions = (await (await fetch(base + `/api/events/${plntm.event_id}/sessions`)).json()).sessions;
  const sold = (id) => db.prepare('SELECT sold FROM event_sessions WHERE id = ?').get(id).sold;

  await t.test('explicit selection consumes cancel-voided tickets, no capacity re-release', async () => {
    const o = await paidOrder(cashier, [
      { product_id: adult.id, qty: 1 },
      { product_id: plntm.id, qty: 2, event_session_id: sessions[0].id },
    ]);
    const plLine = o.lines.find((l) => l.sku === 'PLNTM');
    const cancel = await mgr('POST', `/api/events/sessions/${sessions[0].id}/cancel`, {});
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.voided_tickets, 2);
    const soldAfterCancel = sold(sessions[0].id);

    const r = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: plLine.id, qty: 2 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.refund.total_cents, plLine.line_total_cents);
    assert.equal(r.data.order.status, 'partial_refund');
    assert.equal(r.data.voided_tickets, 0); // already void — nothing flipped
    assert.equal(r.data.order.lines.find((l) => l.id === plLine.id).refunded_qty, 2);
    assert.equal(sold(sessions[0].id), soldAfterCancel);
  });

  await t.test('cancel-voided consumed before valid; exchanged-away still excluded', async () => {
    const o = await paidOrder(cashier, [
      { product_id: plntm.id, qty: 2, event_session_id: sessions[1].id },
    ]);
    const line = o.lines[0];
    const ex = await mgr('POST', `/api/pos/tickets/${o.tickets[0].id}/exchange`, {
      approver: APPROVER, event_session_id: sessions[2].id,
    });
    assert.equal(ex.status, 200);
    assert.equal((await mgr('POST', `/api/events/sessions/${sessions[1].id}/cancel`, {})).status, 200);
    const soldTarget = sold(sessions[2].id);

    // qty 1 must take the cancel-voided ticket, keeping the exchanged replacement
    const r1 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: line.id, qty: 1 }],
    });
    assert.equal(r1.status, 200);
    assert.equal(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ex.data.ticket.id).status, 'valid');
    assert.equal(sold(sessions[2].id), soldTarget);

    // the remaining qty is the replacement itself: refunding it releases its session
    const r2 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: line.id, qty: 1 }],
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.voided_tickets, 1);
    assert.equal(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ex.data.ticket.id).status, 'void');
    assert.equal(sold(sessions[2].id), soldTarget - 1);
    const done = (await cashier('GET', `/api/pos/orders/${o.id}`)).data.order;
    assert.equal(done.status, 'refunded');
    // money summed exactly to the line total across the two slices
    const agg = db.prepare(
      'SELECT SUM(total_cents) AS total FROM refund_lines WHERE order_line_id = ?'
    ).get(line.id);
    assert.equal(agg.total, line.line_total_cents);
  });
});

// separate server: the approver credential path is rate-limited per IP
// (20/min) and the battery above spends most of that budget
test('pos: refund state guards + XSS round-trip', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 50000 })).status, 200);
  const mgr = await login(base, 'manager');
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');

  await t.test('open and void orders are not refundable', async () => {
    const open = (await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    })).data.order;
    let r = await mgr('POST', `/api/pos/orders/${open.id}/refund`, { approver: APPROVER });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'not_refundable');
    await mgr('POST', `/api/pos/orders/${open.id}/void`, { approver: APPROVER });
    r = await mgr('POST', `/api/pos/orders/${open.id}/refund`, { approver: APPROVER });
    assert.equal(r.status, 409);
    r = await mgr('POST', '/api/pos/orders/999999/refund', { approver: APPROVER });
    assert.equal(r.status, 404);
  });

  await t.test('XSS payload in customer name stays inert data end to end', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const o2 = await paidOrder(cashier, [{ product_id: adult.id, qty: 1 }], null,
      { customer: { name: payload, email: 'x@example.com' } });
    assert.equal(o2.customer_name, payload); // stored + returned verbatim, JSON-encoded
    assert.equal(o2.tickets[0].holder_name, payload);
    const r = await mgr('POST', `/api/pos/orders/${o2.id}/refund`, { approver: APPROVER });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.customer_name, payload);
  });
});

test('pos: session exchange — capacity-guarded void + reissue', async (t) => {
  const { server, db, base, ctx } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 50000 })).status, 200);
  const mgr = await login(base, 'manager');
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');
  const plntm = sell.find((p) => p.sku === 'PLNTM');
  const sessions = (await (await fetch(base + `/api/events/${plntm.event_id}/sessions`)).json()).sessions;
  const [sA, sB, sC, sD] = sessions;

  const o = await paidOrder(cashier, [
    { product_id: adult.id, qty: 1 },
    { product_id: plntm.id, qty: 2, event_session_id: sA.id },
  ]);
  const plTickets = o.tickets.filter((tk) => tk.event_session_id === sA.id);
  const adultTicket = o.tickets.find((tk) => tk.event_session_id === null);
  const paymentsBefore = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(o.id).n;

  let newTicket;
  await t.test('happy path: old void + linked reissue, capacity moves, no money', async () => {
    const soldA = eventsMod.getSession(db, sA.id).sold;
    const soldB = eventsMod.getSession(db, sB.id).sold;
    const r = await mgr('POST', `/api/pos/tickets/${plTickets[0].id}/exchange`, {
      approver: APPROVER, event_session_id: sB.id,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.old_ticket.status, 'void');
    newTicket = r.data.ticket;
    assert.equal(newTicket.status, 'valid');
    assert.equal(newTicket.event_session_id, sB.id);
    assert.equal(newTicket.exchanged_from, plTickets[0].id);
    assert.equal(newTicket.order_line_id, plTickets[0].order_line_id);
    assert.equal(newTicket.uses_remaining, plTickets[0].uses_remaining);
    assert.notEqual(newTicket.code, plTickets[0].code);
    assert.match(newTicket.code, /^T-[A-Z0-9]{10}$/);
    // validity window covers the target session
    assert.ok(Date.parse(newTicket.valid_to) >= Date.parse(sB.ends_at || 0));
    assert.equal(eventsMod.getSession(db, sA.id).sold, soldA - 1);
    assert.equal(eventsMod.getSession(db, sB.id).sold, soldB + 1);
    // no payment rows moved, order status untouched
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(o.id).n, paymentsBefore);
    assert.equal((await cashier('GET', `/api/pos/orders/${o.id}`)).data.order.status, 'paid');
    // old code scans denied 'void' with the exchange hint
    const scan = await mgr('POST', '/api/admissions/scan', { code: plTickets[0].code });
    assert.equal(scan.data.result, 'denied');
    assert.equal(scan.data.reason, 'void');
    assert.match(scan.data.detail, /exchanged/i);
    // audit row with approver
    const a = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'pos.ticket.exchange' ORDER BY id DESC LIMIT 1"
    ).get();
    const detail = JSON.parse(a.detail);
    assert.equal(detail.ticket_id, plTickets[0].id);
    assert.equal(detail.new_ticket_id, newTicket.id);
    assert.equal(detail.from_session, sA.id);
    assert.equal(detail.to_session, sB.id);
    assert.ok(detail.approved_by);
  });

  await t.test('full target session: 409 capacity, original untouched, no drift', async () => {
    db.prepare('UPDATE event_sessions SET capacity = sold WHERE id = ?').run(sC.id);
    const before = {
      a: eventsMod.getSession(db, sA.id).sold,
      c: eventsMod.getSession(db, sC.id).sold,
    };
    // repeated attempts must not net-decrement any session (capacity laundering)
    for (let i = 0; i < 3; i++) {
      const r = await mgr('POST', `/api/pos/tickets/${plTickets[1].id}/exchange`, {
        approver: APPROVER, event_session_id: sC.id,
      });
      assert.equal(r.status, 409);
      assert.equal(r.data.error, 'capacity');
    }
    assert.equal(eventsMod.getSession(db, sA.id).sold, before.a);
    assert.equal(eventsMod.getSession(db, sC.id).sold, before.c);
    assert.equal(db.prepare('SELECT status FROM tickets WHERE id = ?').get(plTickets[1].id).status, 'valid');
    const before2 = db.prepare('SELECT status, uses_remaining FROM tickets WHERE id = ?')
      .get(plTickets[1].id);
    const scan = await mgr('POST', '/api/admissions/scan', { code: plTickets[1].code });
    // still a live ticket (ok inside its window, wrong_session_time outside — never void)
    assert.notEqual(scan.data.reason, 'void');
    // Inside the entry window that scan ADMITS and burns the use, which would
    // leave the ticket 'used' for the subtests below; outside it changes nothing.
    // Restore the pre-scan state so what follows does not depend on the clock.
    db.prepare('UPDATE tickets SET status = ?, uses_remaining = ? WHERE id = ?')
      .run(before2.status, before2.uses_remaining, plTickets[1].id);
  });

  await t.test('rejects: same session, cancelled session, other event, bad ids, wrong ticket state', async () => {
    const tid = plTickets[1].id;
    let r = await mgr('POST', `/api/pos/tickets/${tid}/exchange`, {
      approver: APPROVER, event_session_id: sA.id,
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'same_session');

    db.prepare('UPDATE event_sessions SET cancelled = 1 WHERE id = ?').run(sD.id);
    r = await mgr('POST', `/api/pos/tickets/${tid}/exchange`, {
      approver: APPROVER, event_session_id: sD.id,
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_session');

    // a session that belongs to a different event
    db.exec("INSERT INTO events (name, description) VALUES ('Other Show', '')");
    const otherEvent = db.prepare("SELECT id FROM events WHERE name = 'Other Show'").get().id;
    db.prepare(
      'INSERT INTO event_sessions (event_id, starts_at, ends_at, capacity) VALUES (?, ?, ?, 10)'
    ).run(otherEvent, new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString());
    const foreign = db.prepare('SELECT id FROM event_sessions WHERE event_id = ?').get(otherEvent).id;
    r = await mgr('POST', `/api/pos/tickets/${tid}/exchange`, {
      approver: APPROVER, event_session_id: foreign,
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_session');

    for (const bad of ['5', 2.5, null, undefined, -1]) {
      r = await mgr('POST', `/api/pos/tickets/${tid}/exchange`, {
        approver: APPROVER, event_session_id: bad,
      });
      assert.equal(r.status, 400, `session id ${JSON.stringify(bad)} rejected`);
    }

    // untimed ticket
    r = await mgr('POST', `/api/pos/tickets/${adultTicket.id}/exchange`, {
      approver: APPROVER, event_session_id: sB.id,
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'not_timed');

    // already-void (exchanged-away) ticket
    r = await mgr('POST', `/api/pos/tickets/${plTickets[0].id}/exchange`, {
      approver: APPROVER, event_session_id: sB.id,
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'not_exchangeable');

    // used ticket cannot be laundered into a fresh one
    db.prepare("UPDATE tickets SET status = 'used', uses_remaining = 0 WHERE id = ?").run(newTicket.id);
    r = await mgr('POST', `/api/pos/tickets/${newTicket.id}/exchange`, {
      approver: APPROVER, event_session_id: sA.id,
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'not_exchangeable');

    r = await mgr('POST', '/api/pos/tickets/999999/exchange', {
      approver: APPROVER, event_session_id: sB.id,
    });
    assert.equal(r.status, 404);
  });

  await t.test('refunding a line after an exchange releases the session the ticket actually occupies', async () => {
    // plTickets[1] is still valid on sA; the exchanged replacement lives on sB
    // (marked used above, so a full-line explicit refund must refuse) — refund
    // just the remaining valid quantity: 1 of 2
    const line = o.lines.find((l) => l.sku === 'PLNTM');
    const soldA = eventsMod.getSession(db, sA.id).sold;
    const soldB = eventsMod.getSession(db, sB.id).sold;
    const r = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: line.id, qty: 1 }],
    });
    assert.equal(r.status, 200);
    // the valid ticket on sA was voided, so sA released — sB untouched
    assert.equal(eventsMod.getSession(db, sA.id).sold, soldA - 1);
    assert.equal(eventsMod.getSession(db, sB.id).sold, soldB);
    assert.equal(r.data.order.status, 'partial_refund');
    assert.ok(ctx.modules.pos, 'pos module mounted');
  });
});

test('pos: refund/exchange authz — anon 401, gate 403, approver required', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 50000 })).status, 200);
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const plntm = sell.find((p) => p.sku === 'PLNTM');
  const sessions = (await (await fetch(base + `/api/events/${plntm.event_id}/sessions`)).json()).sessions;
  const o = await paidOrder(cashier, [{ product_id: plntm.id, qty: 1, event_session_id: sessions[0].id }]);
  const tk = o.tickets[0];

  await t.test('anonymous requests are 401', async () => {
    for (const p of [`/api/pos/orders/${o.id}/refund`, `/api/pos/tickets/${tk.id}/exchange`]) {
      const r = await fetch(base + p, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(r.status, 401);
    }
  });

  await t.test('gate role is 403 forbidden on both routes', async () => {
    const gate = await login(base, 'gate');
    assert.equal((await gate('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER })).status, 403);
    assert.equal((await gate('POST', `/api/pos/tickets/${tk.id}/exchange`,
      { approver: APPROVER, event_session_id: sessions[1].id })).status, 403);
  });

  await t.test('sellers without a valid manager credential get a generic 403', async () => {
    const cases = [
      {}, // missing approver
      { approver: { username: 'cashier', password: 'cashier' } }, // wrong role
      { approver: { username: 'manager', password: 'wrong' } },   // wrong password
    ];
    for (const body of cases) {
      let r = await cashier('POST', `/api/pos/orders/${o.id}/refund`, body);
      assert.equal(r.status, 403);
      assert.equal(r.data.error, 'approval_required');
      r = await cashier('POST', `/api/pos/tickets/${tk.id}/exchange`,
        { ...body, event_session_id: sessions[1].id });
      assert.equal(r.status, 403);
      assert.equal(r.data.error, 'approval_required');
    }
    // nothing changed while being probed
    const after = (await cashier('GET', `/api/pos/orders/${o.id}`)).data.order;
    assert.equal(after.status, 'paid');
    assert.equal(after.tickets[0].status, 'valid');
  });

  await t.test('a cashier session with a real manager credential succeeds', async () => {
    const r = await cashier('POST', `/api/pos/tickets/${tk.id}/exchange`, {
      approver: APPROVER, event_session_id: sessions[1].id,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ticket.event_session_id, sessions[1].id);
  });
});

test('reporting: partial refunds and exchanges keep reports and the journal honest', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 50000 })).status, 200);
  const mgr = await login(base, 'manager');
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');
  const plntm = sell.find((p) => p.sku === 'PLNTM');
  const sessions = (await (await fetch(base + `/api/events/${plntm.event_id}/sessions`)).json()).sessions;

  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const RANGE = `?from=${today}&to=${today}`;

  // 3-line discounted sale, then a partial refund of the session line, then an
  // exchange of a surviving ticket — the brief's "mixed day".
  const o = await paidOrder(cashier, [
    { product_id: adult.id, qty: 2 },
    { product_id: plntm.id, qty: 2, event_session_id: sessions[0].id },
  ], null, { discount_code: 'SAVE10' });
  const plLine = o.lines.find((l) => l.sku === 'PLNTM');
  const refund = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
    approver: APPROVER, lines: [{ order_line_id: plLine.id, qty: 1 }],
  });
  assert.equal(refund.status, 200);
  const refundCents = refund.data.refund.total_cents;
  const survivor = refund.data.order.tickets.find(
    (tk) => tk.order_line_id === plLine.id && tk.status === 'valid'
  );
  const exch = await mgr('POST', `/api/pos/tickets/${survivor.id}/exchange`, {
    approver: APPROVER, event_session_id: sessions[1].id,
  });
  assert.equal(exch.status, 200);

  await t.test('sales report: partial order counted on sale day, refund negative, identity holds', async () => {
    const rep = (await mgr('GET', '/api/reports/sales' + RANGE)).data;
    const row = rep.sections[0].rows.find((r) => r.channel === 'pos');
    assert.equal(row.orders, 1);
    assert.equal(row.gross_cents, o.subtotal_cents);
    assert.equal(row.refunds, 1);
    assert.equal(row.refund_cents, -refundCents);
    assert.equal(row.payments_cents, row.net_cents + row.tax_cents + row.refund_cents);
  });

  await t.test('dashboard counts the partially refunded order', async () => {
    const d = (await mgr('GET', '/api/reports/dashboard')).data;
    assert.equal(d.orders_today, 1);
    assert.equal(d.revenue_cents, o.total_cents - refundCents);
  });

  await t.test('journal balances and the refunded slice reverses on the product account', async () => {
    const rep = (await mgr('GET', '/api/accounts/journal' + RANGE)).data;
    const days = rep.sections.find((s) => s.title === 'Daily totals').rows;
    assert.ok(days.length >= 1);
    for (const d of days) {
      assert.equal(d.difference_cents, 0, `day ${d.date} out of balance`);
      assert.ok(d.debit_cents > 0);
    }
    const j = rep.sections.find((s) => s.title === 'Journal').rows;
    const income = j.find((r) => r.code === '4000'); // ticket income (adult + plntm)
    // credit = full sale gross (immutable history), debit = refunded slice gross only
    assert.equal(income.credit_cents, o.subtotal_cents);
    const rl = db.prepare(
      'SELECT gross_cents, tax_cents, discount_cents FROM refund_lines'
    ).all();
    assert.equal(rl.length, 1);
    assert.equal(income.debit_cents, rl[0].gross_cents);
    const tax = j.find((r) => r.code === '2200');
    assert.equal(tax.debit_cents, rl[0].tax_cents);
    const disc = j.find((r) => r.code === '4900');
    assert.equal(disc.credit_cents, rl[0].discount_cents);
    assert.equal(disc.debit_cents, o.discount_cents);
  });

  await t.test('exchange moved no money: payments identity still exact', () => {
    const payNet = db.prepare(
      'SELECT COALESCE(SUM(amount_cents - change_cents),0) AS s FROM payments'
    ).get().s;
    assert.equal(payNet, o.total_cents - refundCents);
  });

  await t.test('full refund parity: a fully refunded order reports like it always did', async () => {
    const o2 = await paidOrder(cashier, [{ product_id: adult.id, qty: 1 }]);
    assert.equal((await mgr('POST', `/api/pos/orders/${o2.id}/refund`, { approver: APPROVER })).status, 200);
    const rep = (await mgr('GET', '/api/reports/sales' + RANGE)).data;
    const row = rep.sections[0].rows.find((r) => r.channel === 'pos');
    assert.equal(row.orders, 2);
    assert.equal(row.refunds, 2);
    assert.equal(row.refund_cents, -(refundCents + o2.total_cents));
    assert.equal(row.payments_cents, row.net_cents + row.tax_cents + row.refund_cents);
    // backfill-shape check: the refund event covers every line at full qty
    const ev = db.prepare(
      `SELECT rl.qty, rl.total_cents FROM refund_lines rl
       JOIN refunds r ON r.id = rl.refund_id WHERE r.order_id = ?`
    ).all(o2.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].qty, 1);
    assert.equal(ev[0].total_cents, o2.total_cents);
  });
});

test('pos: refunding a membership takes the membership back', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  const mgr = await login(base, 'manager');
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const memExp = sell.find((p) => p.sku === 'MEM-EXP');

  await t.test('a refunded new membership stops admitting at the gate', async () => {
    const o = await paidOrder(
      cashier,
      [{ product_id: memExp.id, qty: 1, member: { name: 'Wanda Refund', email: 'wanda@example.com' } }],
      [{ method: 'card_sim', amount_cents: 9900 }]
    );
    const member = db.prepare("SELECT * FROM members WHERE lower(email) = 'wanda@example.com'").get();
    assert.equal(member.status, 'active');
    // it admits while it is paid for
    const before = await mgr('POST', '/api/admissions/scan', { code: member.pass_code });
    assert.equal(before.data.result, 'ok');

    const r = await mgr('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER });
    assert.equal(r.status, 200);
    assert.equal(r.data.order.status, 'refunded');
    assert.deepEqual(
      r.data.revoked_members.map((m) => [m.member_no, m.action]),
      [[member.member_no, 'suspended']]
    );
    const after = db.prepare('SELECT * FROM members WHERE id = ?').get(member.id);
    assert.equal(after.status, 'suspended', 'money back = membership back');
    const scan = await mgr('POST', '/api/admissions/scan', { code: member.pass_code });
    assert.equal(scan.data.result, 'denied', 'a refunded pass must not buy a free year');
    // the reversal shows on the audit row a manager reads
    const detail = JSON.parse(
      db.prepare("SELECT detail FROM audit_log WHERE action = 'pos.order.refund' ORDER BY id DESC LIMIT 1")
        .get().detail
    );
    assert.equal(detail.members[0].member_no, member.member_no);
  });

  await t.test('a refunded renewal gives back only the year that was refunded', async () => {
    await paidOrder(
      cashier,
      [{ product_id: memExp.id, qty: 1, member: { name: 'Rene Newal', email: 'rene@example.com' } }],
      [{ method: 'card_sim', amount_cents: 9900 }]
    );
    const member = db.prepare("SELECT * FROM members WHERE lower(email) = 'rene@example.com'").get();
    const paidThrough = Date.parse(member.expires_at);

    const renewal = await paidOrder(
      cashier,
      [{ product_id: memExp.id, qty: 1, member: { member_id: member.id } }],
      [{ method: 'card_sim', amount_cents: 9900 }]
    );
    const extended = db.prepare('SELECT * FROM members WHERE id = ?').get(member.id);
    assert.ok(Date.parse(extended.expires_at) > paidThrough);

    const r = await mgr('POST', `/api/pos/orders/${renewal.id}/refund`, { approver: APPROVER });
    assert.equal(r.status, 200);
    const back = db.prepare('SELECT * FROM members WHERE id = ?').get(member.id);
    assert.equal(back.status, 'active', 'the year they still paid for survives');
    assert.equal(Date.parse(back.expires_at), paidThrough, 'only the refunded year comes off');
    const scan = await mgr('POST', '/api/admissions/scan', { code: member.pass_code });
    assert.equal(scan.data.result, 'ok');
  });
});

test('pos: multi-unit membership lines refund every pass they sold', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  const mgr = await login(base, 'manager');
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const memExp = sell.find((p) => p.sku === 'MEM-EXP');
  const memberByEmail = (email) =>
    db.prepare('SELECT * FROM members WHERE lower(email) = lower(?) ORDER BY id').all(email);
  const scan = async (code) =>
    (await mgr('POST', '/api/admissions/scan', { code })).data.result;

  await t.test('qty-2 gift line: partial refund suspends the newest pass, full refund both', async () => {
    const o = await paidOrder(
      cashier,
      [{ product_id: memExp.id, qty: 2, member: { name: 'Gift Pair', email: 'pair@example.com' } }],
      [{ method: 'card_sim', amount_cents: 19800 }]
    );
    const [a, b] = memberByEmail('pair@example.com');
    assert.ok(a && b && a.id !== b.id, 'two units minted two distinct members');
    // every posted member is recorded, even though member_id stamps only the last
    assert.deepEqual(
      db.prepare(
        'SELECT member_id, action FROM order_line_members WHERE order_line_id = ? ORDER BY id'
      ).all(o.lines[0].id),
      [{ member_id: a.id, action: 'minted' }, { member_id: b.id, action: 'minted' }]
    );

    const r1 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: o.lines[0].id, qty: 1 }],
    });
    assert.equal(r1.status, 200);
    // deterministic: the most recently minted pass comes back
    assert.deepEqual(
      r1.data.revoked_members.map((m) => [m.member_no, m.action]),
      [[b.member_no, 'suspended']]
    );
    assert.equal(db.prepare('SELECT status FROM members WHERE id = ?').get(b.id).status, 'suspended');
    const aAfter = db.prepare('SELECT * FROM members WHERE id = ?').get(a.id);
    assert.equal(aAfter.status, 'active');
    assert.equal(aAfter.expires_at, a.expires_at, 'the surviving pass keeps its full term');
    assert.equal(await scan(a.pass_code), 'ok');
    assert.equal(await scan(b.pass_code), 'denied');

    const r2 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.order.status, 'refunded');
    // all the money is back, so NO pass may still admit
    assert.equal(db.prepare('SELECT status FROM members WHERE id = ?').get(a.id).status, 'suspended');
    assert.equal(await scan(a.pass_code), 'denied');
  });

  const webCheckout = async (email, qty) => {
    const cat = await (await fetch(base + '/api/store/catalog')).json();
    const webMem = cat.products.find((p) => p.kind === 'membership');
    const res = await fetch(base + '/api/store/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lines: [{ product_id: webMem.id, qty }],
        customer: { name: 'Merge Buyer', email },
        card: { number: '4242 4242 4242 4242' },
      }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).order;
  };

  await t.test('qty-2 bare web line (cart merge): both passes delivered and both come back', async () => {
    const o = await webCheckout('merge@example.com', 2);
    const [a, b] = memberByEmail('merge@example.com');
    assert.ok(a && b && a.id !== b.id);
    // delivery surface: a qty-2 purchase shows TWO pass cards, not one
    assert.equal(o.members.length, 2);
    assert.deepEqual(o.members.map((m) => m.member_no).sort(), [a.member_no, b.member_no].sort());

    const r1 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: o.lines[0].id, qty: 1 }],
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(
      r1.data.revoked_members.map((m) => [m.member_no, m.action]),
      [[b.member_no, 'suspended']]
    );
    const aAfter = db.prepare('SELECT * FROM members WHERE id = ?').get(a.id);
    assert.equal(aAfter.status, 'active');
    assert.equal(aAfter.expires_at, a.expires_at);

    const r2 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER });
    assert.equal(r2.status, 200);
    assert.equal(db.prepare('SELECT status FROM members WHERE id = ?').get(a.id).status, 'suspended');
  });

  await t.test('bare qty-2 for a returning buyer: the extra pass first, then the renewal year', async () => {
    const first = await webCheckout('return@example.com', 1);
    assert.equal(first.members.length, 1);
    const [m] = memberByEmail('return@example.com');
    const paidThrough = m.expires_at;

    const o = await webCheckout('return@example.com', 2); // unit 1 renews m, unit 2 mints a new pass
    const fresh = memberByEmail('return@example.com').find((x) => x.id !== m.id);
    assert.ok(fresh, 'the second unit minted its own member');
    assert.deepEqual(
      db.prepare(
        'SELECT member_id, action FROM order_line_members WHERE order_line_id = ? ORDER BY id'
      ).all(o.lines[0].id),
      [{ member_id: m.id, action: 'renewed' }, { member_id: fresh.id, action: 'minted' }]
    );

    // refund 1: the minted extra pass is suspended, the renewal keeps its new year
    const r1 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, {
      approver: APPROVER, lines: [{ order_line_id: o.lines[0].id, qty: 1 }],
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(
      r1.data.revoked_members.map((x) => [x.member_no, x.action]),
      [[fresh.member_no, 'suspended']]
    );
    // refund 2: only the renewed year comes off — the original term survives, active
    const r2 = await mgr('POST', `/api/pos/orders/${o.id}/refund`, { approver: APPROVER });
    assert.equal(r2.status, 200);
    assert.deepEqual(
      r2.data.revoked_members.map((x) => [x.member_no, x.action]),
      [[m.member_no, 'expiry_rolled_back']]
    );
    const back = db.prepare('SELECT * FROM members WHERE id = ?').get(m.id);
    assert.equal(back.status, 'active', 'the year they still paid for survives');
    assert.equal(Date.parse(back.expires_at), Date.parse(paidThrough));
  });
});

test('pos: abandoning an open order needs no manager', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');
  const gate = await login(base, 'gate');
  const mgr = await login(base, 'manager');
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');
  const open = async () => (
    await cashier('POST', '/api/pos/orders', { lines: [{ product_id: adult.id, qty: 1 }] })
  ).data.order;

  await t.test('the seller who opened it can drop it, no approver typed', async () => {
    const o = await open();
    const r = await cashier('POST', `/api/pos/orders/${o.id}/abandon`, {});
    assert.equal(r.status, 200);
    assert.equal(r.data.order.status, 'void');
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'open'").get().n, 0,
      'an abandoned tender leaves no orphaned open order behind'
    );
    const a = db
      .prepare("SELECT * FROM audit_log WHERE action = 'pos.order.abandon' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(JSON.parse(a.detail).order_id, o.id);
  });

  await t.test('managers can drop anyone’s; the gate role cannot touch it', async () => {
    const mine = await open();
    assert.equal((await gate('POST', `/api/pos/orders/${mine.id}/abandon`, {})).status, 403);
    assert.equal((await mgr('POST', `/api/pos/orders/${mine.id}/abandon`, {})).status, 200);
  });

  await t.test('paid orders are never abandonable — refund is the only way back', async () => {
    assert.equal((await cashier('POST', '/api/drawer/open', { float_cents: 10000 })).status, 200);
    const paid = await paidOrder(cashier, [{ product_id: adult.id, qty: 1 }]);
    const r = await cashier('POST', `/api/pos/orders/${paid.id}/abandon`, {});
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'not_voidable');
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(paid.id).status, 'paid');
  });
});
