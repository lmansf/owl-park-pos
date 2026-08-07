'use strict';
// End-to-end smoke: boots a scratch server + DB and walks the full business loop:
// POS sale (split tender, discount, timed session) → gate scans (ok / double / refund-void)
// → web order (approve + decline + recovery) → membership sell + renew + scan
// → full refund → partial refund + session exchange → reports reconcile.
// Exits non-zero on any failed assertion.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { createApp } = require('../server/main');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✔ ${label}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-smoke-'));
  const { server, db } = createApp(path.join(dir, 'smoke.db'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const jars = {}; // per-user cookie jars
  const as = (who) => async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', cookie: jars[who] || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) jars[who] = sc.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  const anon = as('anon');
  const cashier = as('cashier');
  const manager = as('manager');

  console.log('— sign in —');
  ok((await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' })).status === 200, 'cashier login');
  ok((await manager('POST', '/api/auth/login', { username: 'manager', password: 'manager' })).status === 200, 'manager login');

  console.log('— POS sale: 2×adult + planetarium + SAVE10, split tender —');
  const sellable = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sellable.find((p) => p.sku === 'ADULT');
  const plntm = sellable.find((p) => p.sku === 'PLNTM');
  const memProd = sellable.find((p) => p.sku === 'MEM-EXP');
  ok(adult && plntm && memProd, 'sellable feed has ADULT, PLNTM, MEM-EXP');

  const sessions = (await anon('GET', `/api/events/${plntm.event_id}/sessions`)).data.sessions;
  ok(sessions.length > 0, 'planetarium sessions available');
  const sess = sessions.find((s) => !s.sold_out);
  const soldBefore = sess.sold;

  const created = await cashier('POST', '/api/pos/orders', {
    lines: [
      { product_id: adult.id, qty: 2 },
      { product_id: plntm.id, qty: 1, event_session_id: sess.id },
    ],
    discount_code: 'SAVE10',
    customer: { name: 'Smoke Test', email: 'smoke@example.com' },
  });
  ok(created.status === 200, 'order created');
  const order = created.data.order;
  const gross = 2 * adult.price_cents + plntm.price_cents;
  ok(order.discount_cents === Math.round(gross * 0.10), 'SAVE10 discounted 10% of gross');
  ok(order.total_cents === order.subtotal_cents - order.discount_cents + order.tax_cents, 'total = subtotal - discount + tax');

  // cash requires an open drawer session — the failed attempt rolls back fully
  const noDrawer = await cashier('POST', `/api/pos/orders/${order.id}/finalize`, {
    payments: [{ method: 'cash', amount_cents: order.total_cents }],
  });
  ok(noDrawer.status === 409 && noDrawer.data.error === 'no_open_drawer',
    'cash finalize without an open drawer → 409 no_open_drawer');
  const drawerOpen = await cashier('POST', '/api/drawer/open', { float_cents: 20000 });
  ok(drawerOpen.status === 200 && drawerOpen.data.session.status === 'open',
    'cashier opens a $200-float drawer');

  const short = await cashier('POST', `/api/pos/orders/${order.id}/finalize`, {
    payments: [{ method: 'cash', amount_cents: 100 }],
  });
  ok(short.status !== 200, 'insufficient tender rejected');

  const cashPart = 5000;
  const fin = await cashier('POST', `/api/pos/orders/${order.id}/finalize`, {
    payments: [
      { method: 'cash', amount_cents: cashPart },
      { method: 'card_sim', amount_cents: order.total_cents - cashPart },
    ],
  });
  ok(fin.status === 200, 'split-tender finalize succeeds');
  ok(fin.data.change_cents === 0, 'exact split tender → no change');
  const tickets = fin.data.tickets;
  ok(tickets.length === 3, 'three tickets issued');
  const sessAfter = (await anon('GET', `/api/events/${plntm.event_id}/sessions`)).data.sessions.find((s) => s.id === sess.id);
  ok(sessAfter.sold === soldBefore + 1, 'session sold count incremented');

  console.log('— gate scans —');
  const gate = as('gate');
  await gate('POST', '/api/auth/login', { username: 'gate', password: 'gate' });
  const adultTickets = tickets.filter((t) => !t.event_session_id);
  const scan1 = await gate('POST', '/api/admissions/scan', { code: adultTickets[0].code, gate: 'main' });
  ok(scan1.data.result === 'ok', 'adult ticket admits');
  const scan2 = await gate('POST', '/api/admissions/scan', { code: adultTickets[0].code, gate: 'main' });
  ok(scan2.data.result === 'denied' && scan2.data.reason === 'exhausted', 'double scan denied: exhausted');
  const scanUnknown = await gate('POST', '/api/admissions/scan', { code: 'T-NOSUCHCODE', gate: 'main' });
  ok(scanUnknown.data.result === 'denied' && scanUnknown.data.reason === 'unknown', 'unknown code denied');
  // session ticket: ok inside entry window, wrong_session_time outside — assert consistency
  const sessTicket = tickets.find((t) => t.event_session_id);
  const win0 = new Date(new Date(sess.starts_at).getTime() - 30 * 60000);
  const inWindow = new Date() >= win0 && new Date() <= new Date(sess.ends_at);
  const scanSess = await gate('POST', '/api/admissions/scan', { code: sessTicket.code, gate: 'main' });
  ok(inWindow ? scanSess.data.result === 'ok' : scanSess.data.reason === 'wrong_session_time',
    `session ticket scan honors entry window (${inWindow ? 'inside' : 'outside'})`);

  console.log('— online store —');
  const declined = await anon('POST', '/api/store/checkout', {
    customer: { name: 'Web Guest', email: 'guest@example.com' },
    lines: [{ product_id: adult.id, qty: 1 }],
    card: { number: '4000 0000 0000 0002' },
  });
  ok(declined.status === 402, 'decline test card → 402, no order');
  const webBuy = await anon('POST', '/api/store/checkout', {
    customer: { name: 'Web Guest', email: 'guest@example.com' },
    lines: [{ product_id: adult.id, qty: 1 }, { product_id: memProd.id, qty: 1 }],
    card: { number: '4242 4242 4242 4242' },
  });
  ok(webBuy.status === 200, 'web checkout approves');
  const conf = webBuy.data.order.confirmation;
  ok(/^W-/.test(conf), 'web confirmation W-XXXXXXXXX');
  ok(webBuy.data.order.members?.length === 1, 'web membership issued a member');
  const recover = await anon('GET', `/api/store/order?code=${conf}&email=guest@example.com`);
  ok(recover.status === 200 && recover.data.order.tickets.length >= 1, 'order recovery with correct email');
  const wrongEmail = await anon('GET', `/api/store/order?code=${conf}&email=wrong@example.com`);
  ok(wrongEmail.status === 404, 'order recovery rejects wrong email');

  console.log('— membership renew + gate —');
  const guestPass = webBuy.data.order.members[0]; // guest view carries no internal id, by design
  const member = (await cashier('GET', '/api/membership/members?q=guest@example.com')).data.members[0];
  ok(member && member.member_no === guestPass.member_no, 'member findable via back-office search');
  const renew = await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: memProd.id, qty: 1, member: { member_id: member.id } }],
    customer: { name: 'Web Guest', email: 'guest@example.com' },
  });
  const renewFin = await cashier('POST', `/api/pos/orders/${renew.data.order.id}/finalize`, {
    payments: [{ method: 'card_sim', amount_cents: renew.data.order.total_cents }],
  });
  ok(renewFin.status === 200, 'renewal order finalizes');
  const renewed = renewFin.data.members[0];
  ok(renewed.id === member.id, 'renewal kept the same member record');
  ok(new Date(renewed.expires_at) > new Date(member.expires_at), 'renewal extended expiry');
  const renewDetail = await cashier('GET', `/api/pos/orders/${renew.data.order.id}`);
  ok(renewDetail.data.order.lines[0].member_id === member.id, 'renewal line stamped with member_id');
  const memberScan = await gate('POST', '/api/admissions/scan', { code: guestPass.pass_code, gate: 'main' });
  ok(memberScan.data.result === 'ok', 'member pass admits');

  console.log('— refund —');
  // the manager opens their own drawer so the cash refund is attributed to it
  ok((await manager('POST', '/api/drawer/open', { float_cents: 5000 })).status === 200,
    'manager opens a $50-float drawer');
  const noApprover = await manager('POST', `/api/pos/orders/${order.id}/refund`, {});
  ok(noApprover.status === 403, 'refund without manager re-auth is refused');
  const refund = await manager('POST', `/api/pos/orders/${order.id}/refund`, {
    approver: { username: 'manager', password: 'manager' },
  });
  ok(refund.status === 200, 'manager refunds the POS order (re-auth approved)');
  const sessAfterRefund = (await anon('GET', `/api/events/${plntm.event_id}/sessions`)).data.sessions.find((s) => s.id === sess.id);
  ok(sessAfterRefund.sold === soldBefore, 'refund released session capacity');
  const scanVoid = await gate('POST', '/api/admissions/scan', { code: adultTickets[1].code, gate: 'main' });
  ok(scanVoid.data.result === 'denied' && scanVoid.data.reason === 'void', 'refunded ticket scans denied: void');

  console.log('— pluggable tenders —');
  const tenderList = (await cashier('GET', '/api/pos/tenders')).data.tenders;
  ok(tenderList.some((t) => t.method === 'voucher'), 'tender registry serves voucher to sellers');
  const vOrder = (await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: adult.id, qty: 1 }],
  })).data.order;
  const vFin = await cashier('POST', `/api/pos/orders/${vOrder.id}/finalize`, {
    payments: [{ method: 'voucher', amount_cents: vOrder.total_cents }],
  });
  ok(vFin.status === 200 && vFin.data.order.payments[0].method === 'voucher'
    && vFin.data.order.payments[0].ref === 'VOUCHER',
    'voucher payment finalizes through the shared posting path');

  console.log('— partial refund + exchange —');
  const approver = { username: 'manager', password: 'manager' };
  const sessNow = (await anon('GET', `/api/events/${plntm.event_id}/sessions`)).data.sessions;
  const sA = sessNow.find((s) => !s.sold_out);
  const sB = sessNow.find((s) => !s.sold_out && s.id !== sA.id);
  ok(sA && sB, 'two open sessions available for the exchange walk');
  const po = (await cashier('POST', '/api/pos/orders', {
    lines: [
      { product_id: adult.id, qty: 2 },
      { product_id: plntm.id, qty: 3, event_session_id: sA.id },
    ],
    customer: { name: 'Partial Pat', email: 'pat@example.com' },
  })).data.order;
  const pfin = await cashier('POST', `/api/pos/orders/${po.id}/finalize`, {
    payments: [{ method: 'cash', amount_cents: po.total_cents }],
  });
  ok(pfin.status === 200, '3-ticket timed order finalizes');
  const soldA1 = (await anon('GET', `/api/events/${plntm.event_id}/sessions`)).data.sessions
    .find((s) => s.id === sA.id).sold;
  const adultLine = po.lines.find((l) => l.sku === 'ADULT');
  const plntmLine = po.lines.find((l) => l.sku === 'PLNTM');
  const pref = await manager('POST', `/api/pos/orders/${po.id}/refund`, {
    approver,
    lines: [
      { order_line_id: adultLine.id, qty: 1 },
      { order_line_id: plntmLine.id, qty: 1 },
    ],
  });
  ok(pref.status === 200 && pref.data.order.status === 'partial_refund',
    'per-line refund leaves the order partial_refund');
  const soldA2 = (await anon('GET', `/api/events/${plntm.event_id}/sessions`)).data.sessions
    .find((s) => s.id === sA.id).sold;
  ok(soldA2 === soldA1 - 1, 'partial refund released exactly one session seat');
  const pAdult = pref.data.order.tickets.filter((tk) => tk.order_line_id === adultLine.id);
  const scanPartVoid = await gate('POST', '/api/admissions/scan',
    { code: pAdult.find((tk) => tk.status === 'void').code, gate: 'main' });
  ok(scanPartVoid.data.result === 'denied' && scanPartVoid.data.reason === 'void',
    'refunded ticket of a partial refund scans denied: void');
  const scanSibling = await gate('POST', '/api/admissions/scan',
    { code: pAdult.find((tk) => tk.status === 'valid').code, gate: 'main' });
  ok(scanSibling.data.result === 'ok', 'sibling ticket of a partial refund still admits');

  const survivor = pref.data.order.tickets.find(
    (tk) => tk.order_line_id === plntmLine.id && tk.status === 'valid');
  const soldB1 = (await anon('GET', `/api/events/${plntm.event_id}/sessions`)).data.sessions
    .find((s) => s.id === sB.id).sold;
  const exch = await manager('POST', `/api/pos/tickets/${survivor.id}/exchange`, {
    approver, event_session_id: sB.id,
  });
  ok(exch.status === 200 && exch.data.ticket.exchanged_from === survivor.id,
    'exchange voids the old ticket and links the reissue');
  const sessAfterExch = (await anon('GET', `/api/events/${plntm.event_id}/sessions`)).data.sessions;
  ok(sessAfterExch.find((s) => s.id === sA.id).sold === soldA2 - 1
    && sessAfterExch.find((s) => s.id === sB.id).sold === soldB1 + 1,
    'exchange moved one seat from the old session to the new');
  const scanExchOld = await gate('POST', '/api/admissions/scan', { code: survivor.code, gate: 'main' });
  ok(scanExchOld.data.result === 'denied' && scanExchOld.data.reason === 'void',
    'exchanged-away code scans denied: void');
  ok(db.prepare('SELECT status FROM tickets WHERE id = ?').get(exch.data.ticket.id).status === 'valid',
    'replacement ticket is valid in the new session');

  console.log('— reports reconcile —');
  const today = new Date();
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const sales = await manager('GET', `/api/reports/sales?from=${d}&to=${d}`);
  ok(sales.status === 200, 'sales report loads');
  const sec = sales.data.sections[0];
  for (const row of sec.rows) {
    assert.equal(row.net_cents, row.gross_cents - row.discount_cents, 'net = gross - discounts per row');
  }
  passed++; console.log('  ✔ net = gross − discounts on every row');
  const payTotal = db.prepare('SELECT COALESCE(SUM(amount_cents - change_cents),0) AS s FROM payments').get().s;
  const paidTotal = db.prepare("SELECT COALESCE(SUM(total_cents),0) AS s FROM orders WHERE status='paid'").get().s;
  // partially refunded orders contribute their unrefunded remainder
  const partialNet = db.prepare(
    `SELECT COALESCE(SUM(o.total_cents), 0)
          - COALESCE((SELECT SUM(r.total_cents) FROM refunds r
                      JOIN orders po ON po.id = r.order_id
                      WHERE po.status = 'partial_refund'), 0) AS s
     FROM orders o WHERE o.status = 'partial_refund'`
  ).get().s;
  ok(payTotal === paidTotal + partialNet,
    'payments (net of change; refunds cancel out) equal live order totals incl. partial remainders');
  const dash = await manager('GET', '/api/reports/dashboard');
  ok(dash.status === 200 && dash.data.admits_ok_today >= 2, 'dashboard reflects admits');
  const csv = await fetch(base + `/api/reports/sales?from=${d}&to=${d}&format=csv`, { headers: { cookie: jars.manager } });
  ok(csv.status === 200 && (csv.headers.get('content-type') || '').includes('text/csv'), 'sales CSV downloads');

  console.log('— builders: groups, menu, storefront —');
  const admin = as('admin');
  ok((await admin('POST', '/api/auth/login', { username: 'admin', password: 'admin' })).status === 200, 'admin login');
  const grp = (await admin('POST', '/api/groups', { name: 'Day Tickets' })).data.group;
  await admin('PUT', `/api/groups/${grp.id}/products`, { product_ids: [adult.id] });
  const groups = (await admin('GET', '/api/groups')).data.groups;
  ok(groups.find((g) => g.id === grp.id)?.product_count === 1, 'group created with product assigned');

  console.log('— reports by group —');
  const grouped = await manager('GET', `/api/reports/sales?from=${d}&to=${d}&group_by=group`);
  ok(grouped.status === 200, 'grouped sales report loads');
  const gsec = grouped.data.sections[0];
  const dayTix = gsec.rows.find((r) => r.group === 'Day Tickets');
  // 6 ADULT sold today: 2 in the (since refunded) POS order + 1 web + 1 voucher
  // + 2 in the partial-refund order — sold units count on their paid day.
  ok(dayTix && dayTix.units === 6 && dayTix.gross_cents === 6 * adult.price_cents,
    "'Day Tickets' group gross equals the day's ADULT gross");
  const ungrouped = gsec.rows.find((r) => r.group === 'Ungrouped');
  ok(ungrouped && ungrouped.units > 0, 'Ungrouped row absorbs products in no group (PLNTM, MEM-EXP)');
  ok(/count in each group/.test(gsec.note || ''), 'multi-group disclosure note present');
  const gcsv = await fetch(base + `/api/reports/sales?from=${d}&to=${d}&group_by=group&format=csv`,
    { headers: { cookie: jars.manager } });
  ok(gcsv.status === 200 && (gcsv.headers.get('content-type') || '').includes('text/csv'),
    'grouped sales CSV downloads');

  const page = (await admin('POST', '/api/menus/pages', { name: 'Front', sort: 1 })).data.page;
  await admin('POST', `/api/menus/pages/${page.id}/buttons`, { product_id: adult.id, position: 1, label: 'Adult' });
  const activeMenu = (await cashier('GET', '/api/menus/active')).data;
  ok(activeMenu.pages.length === 1 && activeMenu.pages[0].buttons[0].product?.name === adult.name,
    'designed menu serves product button to POS');

  console.log('— per-terminal menus: claim Café, sell from its menu —');
  const childProd = sellable.find((p) => p.sku === 'CHILD');
  const cafeTerm = (await admin('POST', '/api/menus/terminals', { name: 'Café' })).data.terminal;
  const foodPage = (await admin('POST', '/api/menus/pages', { name: 'Café Food', sort: 2 })).data.page;
  await admin('POST', `/api/menus/pages/${foodPage.id}/buttons`, { product_id: childProd.id, position: 1 });
  const assign = await admin('PUT', `/api/menus/terminals/${cafeTerm.id}/pages`, { page_ids: [foodPage.id] });
  ok(assign.status === 200, 'admin creates terminal Café and assigns it the food page');
  const cafeMenu = (await cashier('GET', `/api/menus/active?terminal=${cafeTerm.id}`)).data;
  ok(cafeMenu.pages.length === 1 && cafeMenu.pages[0].name === 'Café Food',
    'claimed terminal is served only its assigned page');
  const unclaimedMenu = (await cashier('GET', '/api/menus/active')).data;
  ok(unclaimedMenu.pages.length === 2, 'unclaimed POS still sees the full active menu');
  ok((await cashier('POST', '/api/menus/terminals', { name: 'Rogue' })).status === 403,
    'cashier cannot manage terminals');
  const cafeBtn = cafeMenu.pages[0].buttons[0];
  const cafeOrder = (await cashier('POST', '/api/pos/orders',
    { lines: [{ product_id: cafeBtn.product_id, qty: 1 }] })).data.order;
  const cafeFin = await cashier('POST', `/api/pos/orders/${cafeOrder.id}/finalize`,
    { payments: [{ method: 'card_sim', amount_cents: cafeOrder.total_cents }] });
  ok(cafeFin.status === 200 && cafeFin.data.order.status === 'paid',
    'sale off a terminal-menu button finalizes through the normal chokepoint');

  await admin('PUT', '/api/storefront/settings', { hero_title: 'Welcome to Owl Park' });
  await admin('POST', '/api/storefront/sections', { title: 'Day Tickets', kind: 'groups', config: { group_id: grp.id } });
  const layout = (await anon('GET', '/api/store/layout')).data;
  ok(layout.settings.hero_title === 'Welcome to Owl Park', 'store hero configured');
  const laySec = layout.sections.find((s) => s.title === 'Day Tickets');
  ok(laySec && laySec.products.some((p) => p.id === adult.id), 'group section resolves products for guests');

  console.log('— price program overrides everywhere —');
  const prog = (await admin('POST', '/api/pricing/programs', { name: 'Smoke Sale', starts_on: d, ends_on: d, priority: 10 })).data.program;
  await admin('PUT', `/api/pricing/programs/${prog.id}/entries`, { entries: [{ product_id: adult.id, price_cents: 2495 }] });
  const adultNow = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products.find((p) => p.id === adult.id);
  ok(adultNow.price_cents === 2495 && adultNow.base_price_cents === adult.price_cents
    && adultNow.program_name === 'Smoke Sale', 'feed shows effective price with base + program');
  const progOrder = (await cashier('POST', '/api/pos/orders', { lines: [{ product_id: adult.id, qty: 1 }] })).data.order;
  ok(progOrder.subtotal_cents === 2495, 'POS order charges the program price');
  await cashier('POST', `/api/pos/orders/${progOrder.id}/finalize`, { payments: [{ method: 'card_sim', amount_cents: progOrder.total_cents }] });
  const progWeb = await anon('POST', '/api/store/checkout', {
    customer: { name: 'Sale Shopper', email: 'sale@example.com' },
    lines: [{ product_id: adult.id, qty: 1 }],
    card: { number: '4242 4242 4242 4242' },
  });
  ok(progWeb.data.order.subtotal_cents === 2495, 'web checkout charges the program price');
  await admin('DELETE', `/api/pricing/programs/${prog.id}`, {});
  const adultBack = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products.find((p) => p.id === adult.id);
  ok(adultBack.price_cents === adult.price_cents && adultBack.base_price_cents === undefined,
    'removing the program restores the base price');

  console.log('— GL journal balances —');
  const journal = (await manager('GET', `/api/accounts/journal?from=${d}&to=${d}`)).data;
  const jrows = journal.sections.find((s) => s.title === 'Journal').rows;
  ok(jrows.length > 0, 'journal has entries for the smoke day');
  const byDay = new Map();
  for (const r of jrows) {
    const t = byDay.get(r.date) || { dr: 0, cr: 0 };
    t.dr += r.debit_cents; t.cr += r.credit_cents;
    byDay.set(r.date, t);
  }
  for (const [day, t] of byDay) {
    assert.equal(t.dr, t.cr, `journal balances on ${day}`);
  }
  passed++; console.log('  ✔ journal debits equal credits every day');

  console.log('— drawer sessions: blind close, Z, reconciliation —');
  // ledger movement, then blind-close. The cashier drawer saw exactly one cash
  // payment all run: the $50.00 part of the split tender (change 0).
  ok((await cashier('POST', '/api/drawer/movements', {
    kind: 'paid_out', amount_cents: 1500, reason: 'ice run',
  })).status === 200, 'paid-out recorded');
  const current = await cashier('GET', '/api/drawer/current');
  ok(!JSON.stringify(current.data).includes('expected'),
    'pre-close drawer view stays blind (no expected cash anywhere)');
  // expected = 20000 float − 1500 paid out + 5000 cash = 23500; count 23400 → $1 short
  const zClose = await cashier('POST', '/api/drawer/close', { counted_cents: 23400, note: 'smoke close' });
  ok(zClose.status === 200 && zClose.data.session.z_number === 1, 'blind close issues Z #1');
  ok(zClose.data.session.expected_cents === 23500, 'expected = float + cash − paid-outs');
  ok(zClose.data.session.over_short_cents === -100, 'over/short = counted − expected (−100)');
  const zCash = zClose.data.sections.find((s) => s.title === 'Payments by method')
    .rows.find((r) => r.method === 'cash');
  const dbCash = db.prepare(
    `SELECT COALESCE(SUM(amount_cents - change_cents),0) AS s
     FROM payments WHERE drawer_session_id = ? AND method = 'cash'`
  ).get(zClose.data.session.id).s;
  ok(zCash.amount_cents === dbCash && dbCash === cashPart,
    'Z payments-by-method equals the payments rows for the session');
  // manager drawer took the cash refund: 5000 float − 5000 refund → expected 0
  const mgrClose = await manager('POST', '/api/drawer/close', { counted_cents: 0 });
  ok(mgrClose.status === 200 && mgrClose.data.session.expected_cents === 0
    && mgrClose.data.session.over_short_cents === 0, 'refund netted out of the manager drawer');
  const drawersRep = (await manager('GET', `/api/reports/drawers?from=${d}&to=${d}`)).data;
  const drawersRows = drawersRep.sections.find((s) => s.title === 'Closed drawer sessions').rows;
  ok(drawersRows.length === 2, 'drawers report lists both closed sessions');
  ok(drawersRep.sections.find((s) => s.title === 'Unattributed POS cash').rows[0].amount_cents === 0,
    'no unattributed POS cash with enforcement live');
  ok(drawersRows.reduce((a, r) => a + r.over_short_cents, 0) === -100,
    'park-day over/short totals −100');
  const drawersCsv = await fetch(base + `/api/reports/drawers?from=${d}&to=${d}&format=csv`,
    { headers: { cookie: jars.manager } });
  ok(drawersCsv.status === 200 && (await drawersCsv.text()).includes('Unattributed POS cash'),
    'drawers report CSV downloads');

  console.log('— security: lockout, recovery, session revocation —');
  let lockedOut = true;
  for (let i = 0; i < 5; i++) {
    const bad = await anon('POST', '/api/auth/login', { username: 'cashier', password: 'wrong' });
    lockedOut = lockedOut && bad.status === 401;
  }
  ok(lockedOut, 'five bad logins all rejected with a generic 401');
  const whileLocked = await anon('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  ok(whileLocked.status === 401, 'locked account rejects even the correct password');
  const failedAudits = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login_failed'").get().n;
  ok(failedAudits >= 5, 'failed logins are audit-visible');
  db.prepare("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE username = 'cashier'").run();
  const relogin = await as('cashier-again')('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
  ok(relogin.status === 200, 'clearing the lock restores login');

  const mgr2 = as('manager-2');
  ok((await mgr2('POST', '/api/auth/login', { username: 'manager', password: 'manager' })).status === 200, 'second manager session opens');
  ok((await manager('POST', '/api/auth/revoke-sessions', {})).status === 200, 'manager revokes their sessions');
  ok((await mgr2('GET', '/api/auth/me')).status === 401, 'the other manager session is dead after revoke');
  ok((await manager('GET', '/api/auth/me')).status === 200, 'the revoking session continues on its fresh cookie');

  console.log('— backups —');
  const bkRun = await admin('POST', '/api/backups/run', {});
  ok(bkRun.status === 200 && bkRun.data.backup.bytes > 0, 'admin backup runs');
  const { DatabaseSync } = require('node:sqlite');
  const snap = new DatabaseSync(path.join(dir, 'backups', bkRun.data.backup.file), { readOnly: true });
  ok(snap.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'snapshot passes integrity_check');
  const snapPay = snap.prepare('SELECT COALESCE(SUM(amount_cents - change_cents),0) AS s FROM payments').get().s;
  const snapPaid = snap.prepare("SELECT COALESCE(SUM(total_cents),0) AS s FROM orders WHERE status='paid'").get().s;
  const snapPartial = snap.prepare(
    `SELECT COALESCE(SUM(o.total_cents), 0)
          - COALESCE((SELECT SUM(r.total_cents) FROM refunds r
                      JOIN orders po ON po.id = r.order_id
                      WHERE po.status = 'partial_refund'), 0) AS s
     FROM orders o WHERE o.status = 'partial_refund'`
  ).get().s;
  ok(snapPay === snapPaid + snapPartial, 'snapshot payments reconcile with its own live orders');
  snap.close();
  const bkList = await admin('GET', '/api/backups');
  ok(bkList.data.backups.some((b) => b.name === bkRun.data.backup.file), 'snapshot listed');
  const anonHealth = await anon('GET', '/api/health');
  ok(!('disk_free_bytes' in anonHealth.data) && !('last_backup_at' in anonHealth.data),
    'anonymous health has no disk/backup fields');

  console.log(`\nSMOKE PASSED — ${passed} checks green.`);
  server.close();
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err.message);
  process.exit(1);
});
