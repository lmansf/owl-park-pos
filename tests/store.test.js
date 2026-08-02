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

// cookie-carrying client (guest calls just never log in)
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

const GOOD_CARD = '4242 4242 4242 4242';
const DECLINE_CARD = '4000 0000 0000 0002';

test('store: guest storefront APIs', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const guest = client(base); // never signs in
  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });

  let catalog;
  let plntm; // planetarium timed product
  let adult;
  let membership;
  let session; // a future session with plenty of seats

  await t.test('anonymous catalog: web sellable + events + upcoming sessions', async () => {
    const r = await guest('GET', '/api/store/catalog');
    assert.equal(r.status, 200);
    catalog = r.data;
    assert.ok(Array.isArray(catalog.products) && catalog.products.length > 0);
    assert.ok(catalog.venue.length > 0);
    adult = catalog.products.find((p) => p.sku === 'ADULT');
    plntm = catalog.products.find((p) => p.sku === 'PLNTM');
    membership = catalog.products.find((p) => p.kind === 'membership');
    assert.ok(adult && plntm && membership);
    assert.equal(catalog.events.length, 1);
    assert.ok(catalog.sessions.length > 0);
    const s = catalog.sessions[0];
    assert.ok('remaining' in s && 'sold_out' in s && 'starts_at' in s);
    session = catalog.sessions[catalog.sessions.length - 1];
    assert.equal(session.sold_out, false);
  });

  await t.test('browse availability: public per-day session listing', async () => {
    const day = new Date(session.starts_at);
    const dayStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const r = await guest('GET', `/api/events/${catalog.events[0].id}/sessions?from=${dayStr}&to=${dayStr}`);
    assert.equal(r.status, 200);
    assert.ok(r.data.sessions.length > 0);
    assert.ok(r.data.sessions.some((s) => s.id === session.id));
    assert.ok(r.data.sessions.every((s) => Number.isInteger(s.remaining)));
  });

  await t.test('anonymous discount validation', async () => {
    const ok = await guest('POST', '/api/store/validate-discount', { code: 'save10' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.discount.code, 'SAVE10');
    const bad = await guest('POST', '/api/store/validate-discount', { code: 'NOPE' });
    assert.equal(bad.status, 404);
    assert.equal(bad.data.error, 'bad_discount');
  });

  await t.test('checkout validation: name, email, card shape', async () => {
    const lines = [{ product_id: adult.id, qty: 1 }];
    let r = await guest('POST', '/api/store/checkout', {
      customer: { name: '', email: 'a@b.com' }, lines, card: { number: GOOD_CARD },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'name_required');
    r = await guest('POST', '/api/store/checkout', {
      customer: { name: 'Pat', email: 'not-an-email' }, lines, card: { number: GOOD_CARD },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'email_required');
    r = await guest('POST', '/api/store/checkout', {
      customer: { name: 'Pat', email: 'pat@example.com' }, lines, card: { number: '12ab' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_card');
  });

  await t.test('declined card: 402, nothing written, capacity unchanged', async () => {
    const ordersBefore = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    const ticketsBefore = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
    const soldBefore = db.prepare('SELECT sold FROM event_sessions WHERE id = ?').get(session.id).sold;
    const r = await guest('POST', '/api/store/checkout', {
      customer: { name: 'Deb Cliner', email: 'deb@example.com' },
      lines: [
        { product_id: adult.id, qty: 1 },
        { product_id: plntm.id, qty: 2, event_session_id: session.id },
      ],
      card: { number: DECLINE_CARD },
    });
    assert.equal(r.status, 402);
    assert.equal(r.data.error, 'payment_declined');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, ordersBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, ticketsBefore);
    assert.equal(
      db.prepare('SELECT sold FROM event_sessions WHERE id = ?').get(session.id).sold,
      soldBefore
    );
  });

  let confirmation;
  const buyerEmail = 'gwen@example.com';

  await t.test('successful checkout: paid web order, tickets, member, capacity bump', async () => {
    const soldBefore = db.prepare('SELECT sold FROM event_sessions WHERE id = ?').get(session.id).sold;
    const lines = [
      { product_id: adult.id, qty: 2 },
      { product_id: plntm.id, qty: 2, event_session_id: session.id },
      { product_id: membership.id, qty: 1 },
    ];
    const r = await guest('POST', '/api/store/checkout', {
      customer: { name: 'Gwen Guest', email: buyerEmail },
      lines,
      discount_code: 'SAVE10',
      card: { number: GOOD_CARD },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const order = r.data.order;
    confirmation = r.data.confirmation;
    assert.match(confirmation, /^W-[A-Z2-9]{9}$/);
    assert.equal(order.status, 'paid');
    assert.equal(order.channel, 'web');
    assert.equal(order.discount_code, 'SAVE10');
    // arithmetic identity of the shared pricing path
    assert.equal(
      order.total_cents,
      order.subtotal_cents - order.discount_cents + order.tax_cents
    );
    // 2 adult + 2 planetarium tickets, all Code39-safe codes
    assert.equal(order.tickets.length, 4);
    for (const tk of order.tickets) assert.match(tk.code, /^T-[A-Z2-9]{10}$/);
    assert.equal(order.tickets.filter((tk) => tk.event_name).length, 2);
    // membership issued to the order email
    assert.equal(order.members.length, 1);
    assert.match(order.members[0].pass_code, /^M-[A-Z2-9]{10}$/);
    const memberRow = db
      .prepare('SELECT * FROM members WHERE pass_code = ?')
      .get(order.members[0].pass_code);
    assert.equal(memberRow.email, buyerEmail);
    // capacity is shared state
    assert.equal(
      db.prepare('SELECT sold FROM event_sessions WHERE id = ?').get(session.id).sold,
      soldBefore + 2
    );
    // exactly one card_sim payment for the full total
    const pays = db
      .prepare("SELECT * FROM payments WHERE order_id = (SELECT id FROM orders WHERE confirmation = ?)")
      .all(confirmation);
    assert.equal(pays.length, 1);
    assert.equal(pays[0].method, 'card_sim');
    assert.equal(pays[0].amount_cents, order.total_cents);
  });

  await t.test('same rules as POS: identical basket prices identically', async () => {
    const lines = [
      { product_id: adult.id, qty: 2 },
      { product_id: plntm.id, qty: 2, event_session_id: session.id },
      { product_id: membership.id, qty: 1 },
    ];
    const pos = await cashier('POST', '/api/pos/orders', {
      lines, discount_code: 'SAVE10', customer: { name: 'Compare', email: 'c@x.com' },
    });
    assert.equal(pos.status, 200);
    const web = db.prepare('SELECT * FROM orders WHERE confirmation = ?').get(confirmation);
    assert.equal(pos.data.order.subtotal_cents, web.subtotal_cents);
    assert.equal(pos.data.order.discount_cents, web.discount_cents);
    assert.equal(pos.data.order.tax_cents, web.tax_cents);
    assert.equal(pos.data.order.total_cents, web.total_cents);
  });

  await t.test('lost tab recovery: order lookup needs BOTH code and email', async () => {
    const ok = await guest('GET',
      `/api/store/order?code=${confirmation}&email=${encodeURIComponent(buyerEmail.toUpperCase())}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.order.confirmation, confirmation);
    assert.equal(ok.data.order.tickets.length, 4);
    assert.equal(ok.data.order.members.length, 1);

    const wrongEmail = await guest('GET',
      `/api/store/order?code=${confirmation}&email=someoneelse@example.com`);
    assert.equal(wrongEmail.status, 404);
    assert.equal(wrongEmail.data.error, 'not_found');
    assert.equal(wrongEmail.data.order, undefined);

    const wrongCode = await guest('GET',
      `/api/store/order?code=W-NOTREAL2&email=${encodeURIComponent(buyerEmail)}`);
    assert.equal(wrongCode.status, 404);

    const noEmail = await guest('GET', `/api/store/order?code=${confirmation}`);
    assert.equal(noEmail.status, 404);
  });

  await t.test('bad discount code at checkout is rejected before payment', async () => {
    const ordersBefore = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    const r = await guest('POST', '/api/store/checkout', {
      customer: { name: 'Pat', email: 'pat@example.com' },
      lines: [{ product_id: adult.id, qty: 1 }],
      discount_code: 'BOGUS',
      card: { number: GOOD_CARD },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_discount');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, ordersBefore);
  });

  await t.test('capacity shared with POS: web checkout fails when POS sells out the session', async () => {
    // POS buys every remaining seat of the session the guest wants…
    const s = db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(session.id);
    const remaining = s.capacity - s.sold;
    assert.ok(remaining > 0);
    const posOrder = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: plntm.id, qty: remaining, event_session_id: session.id }],
    });
    assert.equal(posOrder.status, 200);
    const fin = await cashier('POST', `/api/pos/orders/${posOrder.data.order.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: posOrder.data.order.total_cents }],
    });
    assert.equal(fin.status, 200);

    // …then the guest, whose cart still holds the session, checks out.
    const ordersBefore = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    const ticketsBefore = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
    const r = await guest('POST', '/api/store/checkout', {
      customer: { name: 'Late Larry', email: 'larry@example.com' },
      lines: [{ product_id: plntm.id, qty: 1, event_session_id: session.id }],
      card: { number: GOOD_CARD },
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'capacity');
    // whole checkout rolled back: no stray open order, no tickets, no oversell
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, ordersBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, ticketsBefore);
    const after = db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(session.id);
    assert.equal(after.sold, after.capacity);

    // the availability API now reports it sold out
    const avail = await guest('GET', `/api/events/${catalog.events[0].id}/sessions`);
    const view = avail.data.sessions.find((x) => x.id === session.id);
    assert.equal(view.sold_out, true);
    assert.equal(view.remaining, 0);
  });

  await t.test('store pages serve anonymously and stay offline-safe', async () => {
    for (const page of ['/store/', '/store/event.html', '/store/cart.html',
      '/store/confirmation.html', '/store/order.html']) {
      const res = await fetch(base + page);
      assert.equal(res.status, 200, page);
      const html = await res.text();
      assert.doesNotMatch(html, /https?:\/\/(?!localhost|127\.0\.0\.1)/, `${page} references an external URL`);
    }
  });
});
