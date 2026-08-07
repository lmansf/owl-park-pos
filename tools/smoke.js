'use strict';
// End-to-end smoke: boots a scratch server + DB and walks the full business loop:
// POS sale (split tender, discount, timed session) → gate scans (ok / double / refund-void)
// → web order (approve + decline + recovery) → membership sell + renew + scan
// → full refund → reports reconcile. Exits non-zero on any failed assertion.
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
  const memberScan = await gate('POST', '/api/admissions/scan', { code: guestPass.pass_code, gate: 'main' });
  ok(memberScan.data.result === 'ok', 'member pass admits');

  console.log('— refund —');
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
  ok(payTotal === paidTotal, 'payments (net of change; refunds cancel out) equal currently-paid order totals');
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

  const page = (await admin('POST', '/api/menus/pages', { name: 'Front', sort: 1 })).data.page;
  await admin('POST', `/api/menus/pages/${page.id}/buttons`, { product_id: adult.id, position: 1, label: 'Adult' });
  const activeMenu = (await cashier('GET', '/api/menus/active')).data;
  ok(activeMenu.pages.length === 1 && activeMenu.pages[0].buttons[0].product?.name === adult.name,
    'designed menu serves product button to POS');

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

  console.log(`\nSMOKE PASSED — ${passed} checks green.`);
  server.close();
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err.message);
  process.exit(1);
});
