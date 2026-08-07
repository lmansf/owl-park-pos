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

test('drawer: sessions, blind close, Z-reports, cash attribution', async (t) => {
  const { server, db, ctx, base } = await startServer();
  t.after(() => server.close());

  const cashier = client(base);
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  const mgr = client(base);
  await mgr('POST', '/api/auth/login', { username: 'manager', password: 'manager' });
  const gate = client(base);
  await gate('POST', '/api/auth/login', { username: 'gate', password: 'gate' });

  const { data: sell } = await cashier('GET', '/api/catalog/sellable?channel=pos');
  const bySku = Object.fromEntries(sell.products.map((p) => [p.sku, p]));
  const adult = bySku.ADULT; // 2995 + 187 tax = 3182
  const plntm = bySku.PLNTM;
  const sessRes = await fetch(base + `/api/events/${plntm.event_id}/sessions`);
  const { sessions } = await sessRes.json();

  const cashierId = db.prepare("SELECT id FROM users WHERE username = 'cashier'").get().id;
  const managerId = db.prepare("SELECT id FROM users WHERE username = 'manager'").get().id;

  await t.test('authz: anonymous 401, gate 403 everywhere, cashier 403 on manager routes', async () => {
    const anon = await fetch(base + '/api/drawer/current');
    assert.equal(anon.status, 401);
    const anonOpen = await fetch(base + '/api/drawer/open', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(anonOpen.status, 401);

    for (const [method, p] of [
      ['POST', '/api/drawer/open'], ['GET', '/api/drawer/current'],
      ['POST', '/api/drawer/movements'], ['POST', '/api/drawer/close'],
      ['GET', '/api/drawer/sessions'], ['GET', '/api/drawer/sessions/1/z'],
      ['POST', '/api/drawer/sessions/1/close'],
    ]) {
      const r = await gate(method, p, method === 'POST' ? {} : undefined);
      assert.equal(r.status, 403, `gate on ${method} ${p}`);
    }

    assert.equal((await cashier('GET', '/api/drawer/sessions')).status, 403);
    assert.equal((await cashier('POST', '/api/drawer/sessions/1/close', { counted_cents: 0 })).status, 403);
    assert.equal((await cashier('GET', '/api/reports/drawers')).status, 403);
  });

  await t.test('validation: cents, kind, reason, ids', async () => {
    for (const bad of [-1, 1.5, 10_000_001, 'abc', null]) {
      const r = await cashier('POST', '/api/drawer/open', { float_cents: bad });
      assert.equal(r.status, 400, `float ${bad}`);
      assert.equal(r.data.error, 'bad_amount');
    }
    let r = await cashier('POST', '/api/drawer/movements', {
      kind: 'skim', amount_cents: 100, reason: 'x',
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_kind');
    r = await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_in', amount_cents: 0, reason: 'x',
    });
    assert.equal(r.status, 400);
    r = await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_in', amount_cents: 100, reason: '   ',
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_reason');
    r = await cashier('POST', '/api/drawer/close', { counted_cents: -5 });
    assert.equal(r.status, 400);
    r = await cashier('GET', '/api/drawer/sessions/abc/z');
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_id');
    r = await mgr('GET', '/api/drawer/sessions?from=2026-08-02&to=2026-08-01');
    assert.equal(r.status, 400);
  });

  await t.test('no open drawer: movements and close are 409, not silent', async () => {
    let r = await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_in', amount_cents: 100, reason: 'x',
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'drawer_not_open');
    r = await cashier('POST', '/api/drawer/close', { counted_cents: 0 });
    assert.equal(r.status, 409);
    assert.equal((await cashier('GET', '/api/drawer/current')).data.session, null);
  });

  await t.test('cash finalize with no open drawer: 409, full rollback', async () => {
    const s = sessions[0];
    const soldBefore = eventsMod.getSession(db, s.id).sold;
    const r = await cashier('POST', '/api/pos/orders', {
      lines: [
        { product_id: adult.id, qty: 1 },
        { product_id: plntm.id, qty: 1, event_session_id: s.id },
      ],
    });
    const o = r.data.order;
    const fin = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: 100000 }],
    });
    assert.equal(fin.status, 409);
    assert.equal(fin.data.error, 'no_open_drawer');
    const after = await cashier('GET', `/api/pos/orders/${o.id}`);
    assert.equal(after.data.order.status, 'open');
    assert.equal(after.data.order.tickets.length, 0);
    assert.equal(after.data.order.payments.length, 0);
    assert.equal(eventsMod.getSession(db, s.id).sold, soldBefore);

    // pinned choice: card-only POS finalize is allowed without a drawer,
    // its payment row simply carries no drawer attribution
    const ok = await cashier('POST', `/api/pos/orders/${o.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: o.total_cents }],
    });
    assert.equal(ok.status, 200);
    const pay = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(o.id);
    assert.equal(pay.drawer_session_id, null);
  });

  await t.test('web channel never requires a drawer (even for cash)', async () => {
    const pos = ctx.modules.pos;
    const order = pos.createOrder(
      db, ctx, { lines: [{ product_id: adult.id, qty: 1 }] }, 'web'
    );
    const result = pos.finalizeOrder(db, ctx, order.id, [
      { method: 'cash', amount_cents: order.total_cents },
    ]);
    assert.equal(result.order.status, 'paid');
    assert.equal(
      db.prepare('SELECT drawer_session_id FROM payments WHERE order_id = ?').get(order.id)
        .drawer_session_id,
      null
    );
  });

  let session1 = null;
  await t.test('lifecycle: open with float, current view, double-open 409', async () => {
    const r = await cashier('POST', '/api/drawer/open', {
      float_cents: 20000, terminal: 'front-1',
    });
    assert.equal(r.status, 200);
    session1 = r.data.session;
    assert.equal(session1.status, 'open');
    assert.equal(session1.open_float_cents, 20000);
    assert.equal(session1.terminal, 'front-1');

    const cur = await cashier('GET', '/api/drawer/current');
    assert.equal(cur.data.session.id, session1.id);
    assert.equal(cur.data.payment_count, 0);

    const again = await cashier('POST', '/api/drawer/open', { float_cents: 5000 });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'drawer_already_open');

    // schema backstop: the partial unique index rejects a second open row even
    // if application logic ever regresses
    assert.throws(() =>
      db.prepare(
        "INSERT INTO drawer_sessions (terminal, opened_by, opened_at, open_float_cents) VALUES ('x', ?, ?, 0)"
      ).run(cashierId, new Date().toISOString())
    );
  });

  let cashOrderId = null;
  await t.test('attribution: cash and card payments stamp the open session', async () => {
    // cash sale with change: net cash = 3182
    let r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    cashOrderId = r.data.order.id;
    const fin = await cashier('POST', `/api/pos/orders/${cashOrderId}/finalize`, {
      payments: [{ method: 'cash', amount_cents: 5000 }],
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.change_cents, 1818);
    const pay = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(cashOrderId);
    assert.equal(pay.drawer_session_id, session1.id);

    // card sale while the drawer is open is attributed too (payments-by-method on the Z)
    r = await cashier('POST', '/api/pos/orders', {
      lines: [{ product_id: adult.id, qty: 1 }],
    });
    const fin2 = await cashier('POST', `/api/pos/orders/${r.data.order.id}/finalize`, {
      payments: [{ method: 'card_sim', amount_cents: r.data.order.total_cents }],
    });
    assert.equal(fin2.status, 200);
    assert.equal(
      db.prepare('SELECT drawer_session_id FROM payments WHERE order_id = ?')
        .get(r.data.order.id).drawer_session_id,
      session1.id
    );
  });

  await t.test('movements: paid in/out recorded; XSS payload survives as data', async () => {
    assert.equal((await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_in', amount_cents: 1000, reason: 'till top-up',
    })).status, 200);
    assert.equal((await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_out', amount_cents: 500, reason: 'sunscreen run',
    })).status, 200);
    const xss = '<script>alert(1)</script>';
    assert.equal((await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_in', amount_cents: 100, reason: xss,
    })).status, 200);

    const cur = await cashier('GET', '/api/drawer/current');
    assert.equal(cur.data.movements.length, 3);
    assert.equal(cur.data.movements[2].reason, xss); // verbatim data; UI escapes via op.esc
    assert.equal(cur.data.payment_count, 2);
  });

  await t.test('blind: no cashier-visible pre-close response reveals expected cash', async () => {
    const cur = await cashier('GET', '/api/drawer/current');
    const raw = JSON.stringify(cur.data);
    assert.ok(!raw.includes('expected'), 'no expected_* field before close');
    assert.ok(!('expected_cents' in cur.data.session));
    assert.ok(!('counted_cents' in cur.data.session));
    // Z of an open session is not available even to its owner
    const z = await cashier('GET', `/api/drawer/sessions/${session1.id}/z`);
    assert.equal(z.status, 409);
    assert.equal(z.data.error, 'drawer_not_closed');
  });

  await t.test('blind close: over/short math, Z sections, z_number = 1', async () => {
    // expected = 20000 float + 3182 net cash + (1000 + 100) paid in − 500 paid out = 23782
    const close = await cashier('POST', '/api/drawer/close', {
      counted_cents: 23732, note: 'fifty short',
    });
    assert.equal(close.status, 200);
    const s = close.data.session;
    assert.equal(s.z_number, 1);
    assert.equal(s.expected_cents, 23782);
    assert.equal(s.counted_cents, 23732);
    assert.equal(s.over_short_cents, -50);
    assert.equal(s.status, 'closed');

    const methods = close.data.sections.find((x) => x.title === 'Payments by method');
    const cash = methods.rows.find((x) => x.method === 'cash');
    const card = methods.rows.find((x) => x.method === 'card_sim');
    assert.equal(cash.amount_cents, 3182); // net of change
    assert.equal(card.amount_cents, 3182);
    assert.equal(methods.totals.amount_cents, 6364);

    const recon = close.data.sections.find((x) => x.title === 'Cash reconciliation');
    const byItem = Object.fromEntries(recon.rows.map((r) => [r.item, r.amount_cents]));
    assert.equal(byItem['Opening float'], 20000);
    assert.equal(byItem['Cash sales (net of change)'], 3182);
    assert.equal(byItem['Paid in'], 1100);
    assert.equal(byItem['Paid out'], -500);
    assert.equal(byItem['Over/short'], -50);

    const auditRow = db
      .prepare("SELECT * FROM audit_log WHERE action = 'drawer.close' ORDER BY id DESC LIMIT 1")
      .get();
    const detail = JSON.parse(auditRow.detail);
    assert.equal(detail.session_id, session1.id);
    assert.equal(detail.over_short_cents, -50);
    assert.equal(auditRow.user_id, cashierId);
  });

  await t.test('closed sessions are immutable: no movements, no re-close', async () => {
    let r = await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_in', amount_cents: 100, reason: 'late',
    });
    assert.equal(r.status, 409); // no open session anymore
    r = await cashier('POST', '/api/drawer/close', { counted_cents: 0 });
    assert.equal(r.status, 409);
    r = await mgr('POST', `/api/drawer/sessions/${session1.id}/close`, { counted_cents: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'drawer_not_open');
  });

  let session2 = null;
  await t.test('refund attribution: negative rows stamp the acting user\'s drawer', async () => {
    session2 = (await mgr('POST', '/api/drawer/open', { float_cents: 10000 })).data.session;
    const ref = await mgr('POST', `/api/pos/orders/${cashOrderId}/refund`, {
      approver: { username: 'manager', password: 'manager' },
    });
    assert.equal(ref.status, 200);
    const neg = db
      .prepare('SELECT * FROM payments WHERE order_id = ? AND amount_cents < 0')
      .get(cashOrderId);
    assert.equal(neg.amount_cents, -3182);
    assert.equal(neg.drawer_session_id, session2.id);

    // manager's expected drops by the cash refund: 10000 − 3182 = 6818
    const close = await mgr('POST', '/api/drawer/close', { counted_cents: 6818 });
    assert.equal(close.status, 200);
    assert.equal(close.data.session.z_number, 2);
    assert.equal(close.data.session.expected_cents, 6818);
    assert.equal(close.data.session.over_short_cents, 0);
  });

  await t.test('IDOR: cashier cannot read another user\'s Z; manager and owner can', async () => {
    // cashier probing the manager's session looks identical to a missing id
    let r = await cashier('GET', `/api/drawer/sessions/${session2.id}/z`);
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'not_found');
    r = await cashier('GET', '/api/drawer/sessions/999999/z');
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'not_found');
    // owner reads their own; manager reads anyone's
    assert.equal((await cashier('GET', `/api/drawer/sessions/${session1.id}/z`)).status, 200);
    assert.equal((await mgr('GET', `/api/drawer/sessions/${session1.id}/z`)).status, 200);

    const csv = await cashier.raw(`/api/drawer/sessions/${session1.id}/z?format=csv`);
    assert.equal(csv.status, 200);
    assert.ok((csv.headers.get('content-type') || '').includes('text/csv'));
    const text = await csv.text();
    assert.ok(text.includes('Cash reconciliation'));
    assert.ok(text.includes('Payments by method'));
  });

  await t.test('force-close: manager closes an abandoned drawer, audited as forced', async () => {
    const s3 = (await cashier('POST', '/api/drawer/open', { float_cents: 5000 })).data.session;
    const forced = await mgr('POST', `/api/drawer/sessions/${s3.id}/close`, {
      counted_cents: 5000, note: 'shift abandoned',
    });
    assert.equal(forced.status, 200);
    assert.equal(forced.data.session.z_number, 3);
    assert.equal(forced.data.session.over_short_cents, 0);
    assert.equal(forced.data.session.closed_by, managerId);

    const auditRow = db
      .prepare("SELECT * FROM audit_log WHERE action = 'drawer.close' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(JSON.parse(auditRow.detail).forced, true);
    assert.equal(auditRow.user_id, managerId);

    // the cashier's next own-close finds nothing open
    assert.equal((await cashier('POST', '/api/drawer/close', { counted_cents: 0 })).status, 409);
  });

  await t.test('oracle guard: paid-out is never balance-checked, only statically capped', async () => {
    await cashier('POST', '/api/drawer/open', { float_cents: 1000 });
    // wildly exceeds drawer contents — must NOT error (a balance-derived error
    // would let a cashier binary-search the expected total pre-count)
    const big = await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_out', amount_cents: 9_999_999, reason: 'oracle probe',
    });
    assert.equal(big.status, 200);
    const over = await cashier('POST', '/api/drawer/movements', {
      kind: 'paid_out', amount_cents: 10_000_001, reason: 'static cap',
    });
    assert.equal(over.status, 400); // the only cap is the fixed one
    const close = await cashier('POST', '/api/drawer/close', { counted_cents: 0 });
    assert.equal(close.status, 200);
    assert.equal(close.data.session.expected_cents, 1000 - 9_999_999);
  });

  await t.test('sessions list: closed rows carry Z data, open rows stay uncomputed', async () => {
    const open = (await cashier('POST', '/api/drawer/open', { float_cents: 100 })).data.session;
    const list = await mgr('GET', '/api/drawer/sessions');
    assert.equal(list.status, 200);
    const rows = list.data.sessions;
    const closed = rows.filter((s) => s.status === 'closed');
    assert.equal(closed.length, 4);
    assert.ok(closed.every((s) => Number.isInteger(s.z_number) && s.expected_cents !== null));
    const openRow = rows.find((s) => s.id === open.id);
    assert.equal(openRow.status, 'open');
    assert.equal(openRow.expected_cents, null);
    assert.equal(openRow.z_number, null);
    // clean up: blind close the probe drawer
    await cashier('POST', '/api/drawer/close', { counted_cents: 100 });
  });

  await t.test('drawers report: per-session rows, totals, unattributed cash line', async () => {
    let rep = await mgr('GET', '/api/reports/drawers');
    assert.equal(rep.status, 200);
    const sec = rep.data.sections.find((s) => s.title === 'Closed drawer sessions');
    assert.equal(sec.rows.length, 5);
    const z1 = sec.rows.find((r) => r.z_number === 1);
    assert.equal(z1.cash_cents, 3182);
    assert.equal(z1.expected_cents, 23782);
    assert.equal(z1.over_short_cents, -50);
    assert.equal(sec.totals.z_number, ''); // Z numbers are not summed
    assert.equal(
      sec.totals.over_short_cents,
      sec.rows.reduce((a, r) => a + r.over_short_cents, 0)
    );
    const un = rep.data.sections.find((s) => s.title === 'Unattributed POS cash');
    assert.equal(un.rows[0].amount_cents, 0); // enforcement live → nothing unattributed

    // legacy / pre-drawer history shows up on the unattributed line, not silently
    db.prepare('UPDATE payments SET drawer_session_id = NULL WHERE order_id = ? AND amount_cents > 0')
      .run(cashOrderId);
    rep = await mgr('GET', '/api/reports/drawers');
    assert.equal(
      rep.data.sections.find((s) => s.title === 'Unattributed POS cash').rows[0].amount_cents,
      3182
    );

    const csv = await mgr.raw('/api/reports/drawers?format=csv');
    assert.equal(csv.status, 200);
    assert.ok((csv.headers.get('content-type') || '').includes('text/csv'));
    assert.ok((await csv.text()).includes('Unattributed POS cash'));
  });

  // An abandoned drawer used to be invisible: not a closed session, and its
  // payments carry a session id so they are not "unattributed" either.
  await t.test('drawers report: an abandoned open drawer is surfaced, then recoverable', async () => {
    const before = (await mgr('GET', '/api/reports/drawers')).data.sections;
    assert.equal(before.some((s) => s.title.startsWith('OPEN drawer sessions')), false,
      'no section while every drawer is closed');
    const closedBefore = before.find((s) => s.title === 'Closed drawer sessions').rows.length;

    const open = (await cashier('POST', '/api/drawer/open',
      { float_cents: 20000, terminal: 'abandoned' })).data.session;
    const sale = (await cashier('POST', '/api/pos/orders',
      { lines: [{ product_id: adult.id, qty: 1 }] })).data.order;
    assert.equal((await cashier('POST', `/api/pos/orders/${sale.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: sale.total_cents }],
    })).status, 200);
    // ...and the cashier goes home without closing.

    const rep = (await mgr('GET', '/api/reports/drawers')).data;
    const sec = rep.sections[0];
    assert.ok(sec.title.startsWith('OPEN drawer sessions'), 'leads the report');
    assert.equal(sec.rows.length, 1);
    assert.equal(sec.rows[0].session_id, open.id);
    assert.equal(sec.rows[0].terminal, 'abandoned');
    assert.equal(sec.rows[0].cashier, 'Casey Cashier');
    assert.equal(sec.rows[0].float_cents, 20000);
    assert.equal(sec.rows[0].payments, 1);
    assert.equal(sec.totals.float_cents, 20000);
    assert.ok(sec.note.includes('/api/drawer/sessions/'), 'names the recovery route');
    // blind close still holds: no expected/counted cash for an open session
    for (const c of ['expected_cents', 'counted_cents', 'cash_cents', 'over_short_cents']) {
      assert.ok(!sec.columns.includes(c), `open sessions must not expose ${c}`);
    }
    // the closed section is unchanged — that is exactly why the section above matters
    assert.equal(rep.sections.find((s) => s.title === 'Closed drawer sessions').rows.length,
      closedBefore);
    const csv = await (await mgr.raw('/api/reports/drawers?format=csv')).text();
    assert.ok(csv.includes('OPEN drawer sessions'), 'the CSV carries it too');

    // manager counts the till and force-closes someone else's drawer
    const forced = await mgr('POST', `/api/drawer/sessions/${open.id}/close`,
      { counted_cents: 20000 + sale.total_cents, note: 'abandoned till counted' });
    assert.equal(forced.status, 200);
    assert.equal(forced.data.session.over_short_cents, 0);
    const after = (await mgr('GET', '/api/reports/drawers')).data.sections;
    assert.equal(after.some((s) => s.title.startsWith('OPEN drawer sessions')), false);
    assert.equal(after.find((s) => s.title === 'Closed drawer sessions').rows.length,
      closedBefore + 1);
  });
});
