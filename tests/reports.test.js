'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');

const DAY = (24 * 3600 * 1000);

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

// cookie-carrying client; .raw() fetches non-JSON (CSV) with the same session
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
  const raw = async (apiPath) => {
    const res = await fetch(base + apiPath, { headers: { cookie } });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  return { call, raw };
}

const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test('reports: dashboard, four reports, CSV parity, reconciliation', async (t) => {
  const app = await startServer();
  t.after(() => app.server.close());

  const manager = client(app.base);
  const cashier = client(app.base);
  const gate = client(app.base);
  assert.equal((await manager.call('POST', '/api/auth/login', { username: 'manager', password: 'manager' })).status, 200);
  assert.equal((await cashier.call('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' })).status, 200);
  assert.equal((await gate.call('POST', '/api/auth/login', { username: 'gate', password: 'gate' })).status, 200);
  // POS cash needs an open drawer session (drawer-sessions-zreports)
  assert.equal((await cashier.call('POST', '/api/drawer/open', { float_cents: 20000 })).status, 200);

  await t.test('role gates', async () => {
    const anon = await fetch(app.base + '/api/reports/dashboard');
    assert.equal(anon.status, 401);
    assert.equal((await cashier.call('GET', '/api/reports/sales')).status, 403);
    assert.equal((await gate.call('GET', '/api/reports/dashboard')).status, 403,
      'gate is admissions-only — no dashboard financials');
    assert.equal((await cashier.call('GET', '/api/reports/dashboard')).status, 200);
    assert.equal((await manager.call('GET', '/api/reports/sales')).status, 200);
  });

  await t.test('bad range rejected', async () => {
    const r = await manager.call('GET', '/api/reports/sales?from=2026-08-02&to=2026-08-01');
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'bad_range');
  });

  // ---- create mixed activity through the real APIs -------------------------
  const cat = (await cashier.call('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const bySku = Object.fromEntries(cat.map((p) => [p.sku, p]));
  const events = (await cashier.call('GET', '/api/events')).data.events;
  const planet = events.find((e) => e.name === 'Planetarium Show');
  const sessions = (await fetch(app.base + `/api/events/${planet.id}/sessions`).then((r) => r.json())).sessions;
  const session = sessions[0];

  // expected aggregates for "today" accumulated as we go
  let expOrders = 0, expUnits = 0, expGross = 0, expDisc = 0, expTax = 0;
  let expPayments = 0, expRefunds = 0, expRefundCents = 0, expTickets = 0;
  const track = (order, tickets) => {
    expOrders += 1;
    expUnits += order.lines.reduce((a, l) => a + l.qty, 0);
    expGross += order.subtotal_cents;
    expDisc += order.discount_cents;
    expTax += order.tax_cents;
    expPayments += order.total_cents;
    expTickets += tickets;
  };

  // Order 1: cash with change, discounted, includes a timed-entry session line.
  const o1 = (await cashier.call('POST', '/api/pos/orders', {
    lines: [
      { product_id: bySku.ADULT.id, qty: 2 },
      { product_id: bySku.PLNTM.id, qty: 1, event_session_id: session.id },
    ],
    discount_code: 'SAVE10',
    customer: { name: 'Rex Report', email: 'rex@example.com' },
  })).data.order;
  const f1 = (await cashier.call('POST', `/api/pos/orders/${o1.id}/finalize`, {
    payments: [{ method: 'cash', amount_cents: o1.total_cents + 500 }],
  })).data;
  assert.equal(f1.change_cents, 500);
  track(o1, f1.tickets.length);
  assert.equal(f1.tickets.length, 3);

  // Order 2: paid then refunded (same day).
  const o2 = (await cashier.call('POST', '/api/pos/orders', {
    lines: [{ product_id: bySku.ADULT.id, qty: 1 }],
  })).data.order;
  const f2 = (await cashier.call('POST', `/api/pos/orders/${o2.id}/finalize`, {
    payments: [{ method: 'cash', amount_cents: o2.total_cents }],
  })).data;
  track(o2, f2.tickets.length);
  const rf2 = await manager.call('POST', `/api/pos/orders/${o2.id}/refund`,
    { approver: { username: 'manager', password: 'manager' } });
  assert.equal(rf2.status, 200);
  expRefunds += 1;
  expRefundCents -= o2.total_cents;
  expPayments -= o2.total_cents;

  // Order 3: membership sale (new member, card).
  const o3 = (await cashier.call('POST', '/api/pos/orders', {
    lines: [{ product_id: bySku['MEM-EXP'].id, qty: 1,
              member: { name: 'Mia Member', email: 'mia.member@example.com' } }],
  })).data.order;
  const f3 = (await cashier.call('POST', `/api/pos/orders/${o3.id}/finalize`, {
    payments: [{ method: 'card_sim', amount_cents: o3.total_cents }],
  })).data;
  track(o3, 0);
  assert.equal(f3.members.length, 1);

  // Web order too, if the store module is present in this build.
  if (app.ctx.modules.store) {
    const w = await fetch(app.base + '/api/store/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'Wes Web', email: 'wes@example.com' },
        lines: [{ product_id: bySku.ADULT.id, qty: 1 }],
        card: { number: '4242424242421111' },
      }),
    }).then((r) => r.json());
    assert.ok(w.confirmation, 'web checkout returned a confirmation');
    const dbOrder = app.db.prepare('SELECT * FROM orders WHERE confirmation = ?').get(w.confirmation);
    const wTickets = app.db.prepare(
      `SELECT COUNT(*) AS n FROM tickets
       WHERE order_line_id IN (SELECT id FROM order_lines WHERE order_id = ?)`
    ).get(dbOrder.id).n;
    const lines = app.db.prepare('SELECT qty FROM order_lines WHERE order_id = ?').all(dbOrder.id);
    track({ ...dbOrder, lines }, wTickets);
  }

  // Admissions: one OK ticket scan at gate "north", one unknown code at "main".
  const okTicket = f1.tickets.find((tk) => tk.event_session_id === null);
  const scanOk = (await gate.call('POST', '/api/admissions/scan',
    { code: okTicket.code, gate: 'north' })).data;
  assert.equal(scanOk.result, 'ok');
  const scanBad = (await gate.call('POST', '/api/admissions/scan', { code: 'T-NOPE' })).data;
  assert.equal(scanBad.result, 'denied');

  const today = dstr(new Date());

  await t.test('dashboard reflects the activity (sale moves the needle)', async () => {
    const d = (await cashier.call('GET', '/api/reports/dashboard')).data;
    assert.equal(d.revenue_cents, expPayments);
    assert.equal(d.orders_today, expOrders);
    assert.equal(d.tickets_sold_today, expTickets);
    assert.equal(d.admits_ok_today, 1);
    assert.equal(d.admits_denied_today, 1);
    assert.equal(d.in_park_estimate, 1);
    assert.equal(d.members_active, 2); // seeded Dana + Mia
    assert.equal(d.next_sessions.length, 5);
    for (const s of d.next_sessions) {
      assert.ok(s.event_name && s.starts_at && Number.isInteger(s.fill_pct));
      assert.ok(s.fill_pct >= 0 && s.fill_pct <= 100);
    }
  });

  await t.test('sales summary: totals + reconciliation invariants', async () => {
    const rep = (await manager.call('GET', `/api/reports/sales?from=${today}&to=${today}`)).data;
    const sec = rep.sections[0];
    const totals = sec.totals;
    for (const r of sec.rows) {
      assert.equal(r.net_cents, r.gross_cents - r.discount_cents, 'net = gross - discounts');
      assert.equal(r.payments_cents, r.net_cents + r.tax_cents + r.refund_cents,
        'payments = paid totals + (negative) refunds');
    }
    assert.equal(totals.orders, expOrders);
    assert.equal(totals.units, expUnits);
    assert.equal(totals.gross_cents, expGross);
    assert.equal(totals.discount_cents, expDisc);
    assert.equal(totals.tax_cents, expTax);
    assert.equal(totals.net_cents, expGross - expDisc);
    assert.equal(totals.refunds, expRefunds);
    assert.equal(totals.refund_cents, expRefundCents);
    assert.equal(totals.payments_cents, expPayments);
  });

  await t.test('sales CSV matches the on-screen table', async () => {
    const q = `from=${today}&to=${today}`;
    const rep = (await manager.call('GET', `/api/reports/sales?${q}`)).data;
    const csv = await manager.raw(`/api/reports/sales?${q}&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /sales-.*\.csv/);

    const lines = csv.text.trim().split('\n').map((l) => l.split(','));
    const sec = rep.sections[0];
    assert.deepEqual(lines[0], ['Sales summary']);
    assert.deepEqual(lines[1], sec.columns);
    sec.rows.forEach((row, i) => {
      assert.deepEqual(lines[2 + i], sec.columns.map((c) => String(row[c] ?? '')));
    });
    const totalsLine = lines[2 + sec.rows.length];
    assert.deepEqual(totalsLine, sec.columns.map((c) => String(sec.totals[c] ?? '')));
  });

  await t.test('product mix: units, gross, shares sum to 100', async () => {
    const rep = (await manager.call('GET', `/api/reports/product-mix?from=${today}&to=${today}`)).data;
    const sec = rep.sections[0];
    const adult = sec.rows.find((r) => r.sku === 'ADULT');
    assert.ok(adult, 'adult ticket row present');
    assert.ok(adult.units >= 3);
    assert.equal(adult.gross_cents, adult.units * bySku.ADULT.price_cents);
    assert.equal(sec.totals.units, expUnits);
    assert.equal(sec.totals.gross_cents, expGross);
    assert.ok(Math.abs(sec.totals.share_pct - 100) < 0.5, `shares sum ~100, got ${sec.totals.share_pct}`);
  });

  await t.test('admissions: per-day denial reasons + per-gate breakdown', async () => {
    const rep = (await manager.call('GET', `/api/reports/admissions?from=${today}&to=${today}`)).data;
    const [days, gates] = rep.sections;
    const day = days.rows.find((r) => r.date === today);
    assert.ok(day, 'today row present');
    assert.equal(day.scans, 2);
    assert.equal(day.admits, 1);
    assert.equal(day.denied, 1);
    assert.equal(day.unknown, 1);
    assert.equal(day.expired, 0);
    const north = gates.rows.find((r) => r.gate === 'north');
    const main = gates.rows.find((r) => r.gate === 'main');
    assert.deepEqual({ scans: north.scans, admits: north.admits, denied: north.denied },
      { scans: 1, admits: 1, denied: 0 });
    assert.deepEqual({ scans: main.scans, admits: main.admits, denied: main.denied },
      { scans: 1, admits: 0, denied: 1 });
  });

  await t.test('memberships: sold/renewed per program + active counts', async () => {
    const rep = (await manager.call('GET', `/api/reports/memberships?from=${today}&to=${today}`)).data;
    const sec = rep.sections[0];
    const explorer = sec.rows.find((r) => r.program === 'Explorer Annual');
    assert.ok(explorer);
    assert.equal(explorer.units_sold, 1);
    assert.equal(explorer.active_members, 2); // Dana (seed) + Mia
    assert.equal(explorer.expiring_30d, 0);
    assert.ok(explorer.new_members >= 1);
    assert.equal(explorer.renewals, Math.max(0, explorer.units_sold - explorer.new_members));
    const nova = sec.rows.find((r) => r.program === 'Nova Family Annual');
    assert.equal(nova.units_sold, 0);
  });

  await t.test('refund day accounting: paid Monday, refunded Tuesday', async () => {
    // Pay + refund via the real APIs, then time-travel the SALE (paid_at + positive
    // payment rows) back one day. The refund stays today.
    const o4 = (await cashier.call('POST', '/api/pos/orders', {
      lines: [{ product_id: bySku.SENIOR.id, qty: 1 }],
    })).data.order;
    const f4 = (await cashier.call('POST', `/api/pos/orders/${o4.id}/finalize`, {
      payments: [{ method: 'cash', amount_cents: o4.total_cents }],
    })).data;
    assert.equal((await manager.call('POST', `/api/pos/orders/${o4.id}/refund`,
      { approver: { username: 'manager', password: 'manager' } })).status, 200);

    const paidYesterday = new Date(Date.parse(f4.order.paid_at) - DAY).toISOString();
    app.db.prepare('UPDATE orders SET paid_at = ?, created_at = ? WHERE id = ?')
      .run(paidYesterday, paidYesterday, o4.id);
    app.db.prepare('UPDATE payments SET created_at = ? WHERE order_id = ? AND amount_cents > 0')
      .run(paidYesterday, o4.id);

    const yesterday = dstr(new Date(Date.now() - DAY));
    const rep = (await manager.call('GET', `/api/reports/sales?from=${yesterday}&to=${today}`)).data;
    const rows = rep.sections[0].rows;
    const mon = rows.find((r) => r.date === yesterday && r.channel === 'pos');
    assert.ok(mon, 'sale day row present');
    // Monday's sale is intact and untouched by the refund
    assert.equal(mon.orders, 1);
    assert.equal(mon.gross_cents, o4.subtotal_cents);
    assert.equal(mon.net_cents, o4.subtotal_cents - o4.discount_cents);
    assert.equal(mon.refunds, 0);
    assert.equal(mon.refund_cents, 0);
    assert.equal(mon.payments_cents, o4.total_cents);
    // Tuesday shows the negative amount
    const tue = rows.find((r) => r.date === today && r.channel === 'pos');
    assert.equal(tue.refund_cents, expRefundCents - o4.total_cents);
    assert.equal(tue.refunds, expRefunds + 1);
    // and Tuesday's own reconciliation still holds
    assert.equal(tue.payments_cents, tue.net_cents + tue.tax_cents + tue.refund_cents);
  });
});

test('reports: group rollups (sales, admissions, dashboard, CSV, security)', async (t) => {
  const app = await startServer();
  t.after(() => app.server.close());

  const admin = client(app.base);
  const manager = client(app.base);
  const cashier = client(app.base);
  const gate = client(app.base);
  assert.equal((await admin.call('POST', '/api/auth/login', { username: 'admin', password: 'admin' })).status, 200);
  assert.equal((await manager.call('POST', '/api/auth/login', { username: 'manager', password: 'manager' })).status, 200);
  assert.equal((await cashier.call('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' })).status, 200);
  assert.equal((await gate.call('POST', '/api/auth/login', { username: 'gate', password: 'gate' })).status, 200);
  // POS cash needs an open drawer session (drawer-sessions-zreports)
  assert.equal((await cashier.call('POST', '/api/drawer/open', { float_cents: 20000 })).status, 200);

  const cat = (await cashier.call('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const bySku = Object.fromEntries(cat.map((p) => [p.sku, p]));

  // One mixed discounted order: 2×ADULT + 1×CHILD + 1×MEM-EXP (membership stays
  // ungrouped throughout).
  const o1 = (await cashier.call('POST', '/api/pos/orders', {
    lines: [
      { product_id: bySku.ADULT.id, qty: 2 },
      { product_id: bySku.CHILD.id, qty: 1 },
      { product_id: bySku['MEM-EXP'].id, qty: 1,
        member: { name: 'Gia Group', email: 'gia.group@example.com' } },
    ],
    discount_code: 'SAVE10',
  })).data.order;
  const f1 = (await cashier.call('POST', `/api/pos/orders/${o1.id}/finalize`, {
    payments: [{ method: 'cash', amount_cents: o1.total_cents }],
  })).data;
  assert.equal(f1.tickets.length, 3);

  const today = dstr(new Date());
  const rangeQ = `from=${today}&to=${today}`;
  // Expected per-product line aggregates, straight from the DB (line-level discount
  // and tax are exact integer-cent allocations, see pos.js).
  const lineAgg = (productId) => app.db.prepare(
    `SELECT COALESCE(SUM(ol.qty), 0) AS units,
            COALESCE(SUM(ol.qty * ol.unit_price_cents), 0) AS gross,
            COALESCE(SUM(ol.discount_cents), 0) AS disc,
            COALESCE(SUM(ol.tax_cents), 0) AS tax
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id
     WHERE ol.product_id = ? AND o.status IN ('paid', 'refunded')`
  ).get(productId);

  await t.test('no groups yet: everything lands in Ungrouped, reconciles with product mix', async () => {
    const rep = (await manager.call('GET', `/api/reports/sales?${rangeQ}&group_by=group`)).data;
    const sec = rep.sections[0];
    assert.equal(sec.title, 'Sales by item group');
    assert.equal(sec.rows.length, 1);
    assert.equal(sec.rows[0].group, 'Ungrouped');
    const mix = (await manager.call('GET', `/api/reports/product-mix?${rangeQ}`)).data;
    assert.equal(sec.totals.gross_cents, mix.sections[0].totals.gross_cents,
      'no multi-group membership → group gross equals product-mix gross');
    assert.equal(sec.rows[0].net_cents, sec.rows[0].gross_cents - sec.rows[0].discount_cents);
  });

  // Groups: ADULT in both (multi-group case), CHILD in Tickets only, MEM-EXP in none.
  const gTickets = (await admin.call('POST', '/api/groups', { name: 'Tickets', sort: 1 })).data.group;
  const gFood = (await admin.call('POST', '/api/groups', { name: 'Food', sort: 2 })).data.group;
  assert.equal((await admin.call('PUT', `/api/groups/${gTickets.id}/products`,
    { product_ids: [bySku.ADULT.id, bySku.CHILD.id] })).status, 200);
  assert.equal((await admin.call('PUT', `/api/groups/${gFood.id}/products`,
    { product_ids: [bySku.ADULT.id] })).status, 200);

  await t.test('rollup math: multi-group double count, disclosure note, Ungrouped bucket', async () => {
    const adult = lineAgg(bySku.ADULT.id);
    const child = lineAgg(bySku.CHILD.id);
    const mem = lineAgg(bySku['MEM-EXP'].id);
    const rep = (await manager.call('GET', `/api/reports/sales?${rangeQ}&group_by=group`)).data;
    const sec = rep.sections[0];
    assert.deepEqual(sec.rows.map((r) => r.group), ['Tickets', 'Food', 'Ungrouped']);
    const [tix, food, ung] = sec.rows;
    for (const r of sec.rows) {
      assert.equal(r.net_cents, r.gross_cents - r.discount_cents, 'net = gross - discounts');
      for (const c of sec.columns) if (c !== 'group') assert.ok(Number.isInteger(r[c]), `${c} is integer cents`);
    }
    assert.deepEqual(
      { units: tix.units, gross: tix.gross_cents, disc: tix.discount_cents, tax: tix.tax_cents },
      { units: adult.units + child.units, gross: adult.gross + child.gross,
        disc: adult.disc + child.disc, tax: adult.tax + child.tax });
    assert.deepEqual({ units: food.units, gross: food.gross_cents },
      { units: adult.units, gross: adult.gross }, 'ADULT counts again in Food');
    assert.deepEqual({ units: ung.units, gross: ung.gross_cents },
      { units: mem.units, gross: mem.gross }, 'MEM-EXP lands in Ungrouped');
    // Σ group gross exceeds the grand total by exactly the duplicated ADULT gross.
    const mix = (await manager.call('GET', `/api/reports/product-mix?${rangeQ}`)).data;
    assert.equal(sec.totals.gross_cents, mix.sections[0].totals.gross_cents + adult.gross);
    assert.match(sec.note, /count in each group/);
  });

  await t.test('admissions grouped: ticket scans by group, non-ticket scans only in the note', async () => {
    const adultTicket = app.db.prepare(
      'SELECT code FROM tickets WHERE product_id = ?').get(bySku.ADULT.id);
    assert.equal((await gate.call('POST', '/api/admissions/scan',
      { code: adultTicket.code, gate: 'north' })).data.result, 'ok');
    assert.equal((await gate.call('POST', '/api/admissions/scan',
      { code: adultTicket.code, gate: 'north' })).data.result, 'denied'); // exhausted
    assert.equal((await gate.call('POST', '/api/admissions/scan',
      { code: 'T-NOPE' })).data.result, 'denied'); // unknown, no ticket_id

    const rep = (await manager.call('GET', `/api/reports/admissions?${rangeQ}&group_by=group`)).data;
    const sec = rep.sections[0];
    assert.equal(sec.title, 'Admissions by item group');
    assert.deepEqual(sec.rows.map((r) => r.group), ['Tickets', 'Food']);
    for (const r of sec.rows) {
      assert.deepEqual({ scans: r.scans, admits: r.admits, denied: r.denied },
        { scans: 2, admits: 1, denied: 1 }, 'ADULT scans count in both its groups');
    }
    assert.match(sec.note, /1 member\/unknown scan/);
    // aggregate counts only — never ticket codes, holder names, or member data
    const leaked = JSON.stringify(rep);
    assert.ok(!leaked.includes(adultTicket.code), 'no ticket codes in the report');
  });

  await t.test('deactivated group falls out; products re-bucket via remaining groups', async () => {
    assert.equal((await admin.call('DELETE', `/api/groups/${gFood.id}`)).status, 200);
    const rep = (await manager.call('GET', `/api/reports/sales?${rangeQ}&group_by=group`)).data;
    const sec = rep.sections[0];
    assert.deepEqual(sec.rows.map((r) => r.group), ['Tickets', 'Ungrouped']);
    const mix = (await manager.call('GET', `/api/reports/product-mix?${rangeQ}`)).data;
    assert.equal(sec.totals.gross_cents, mix.sections[0].totals.gross_cents,
      'no double count once Food is deactivated');
  });

  await t.test('dashboard: revenue_by_group_today (sales-based, incl. tax)', async () => {
    const adult = lineAgg(bySku.ADULT.id);
    const child = lineAgg(bySku.CHILD.id);
    const mem = lineAgg(bySku['MEM-EXP'].id);
    const d = (await manager.call('GET', '/api/reports/dashboard')).data;
    assert.ok(Array.isArray(d.revenue_by_group_today));
    assert.deepEqual(d.revenue_by_group_today, [
      { group: 'Tickets',
        revenue_cents: (adult.gross - adult.disc + adult.tax) + (child.gross - child.disc + child.tax) },
      { group: 'Ungrouped', revenue_cents: mem.gross - mem.disc + mem.tax },
    ]);
    const cashierDash = (await cashier.call('GET', '/api/reports/dashboard')).data;
    assert.equal(cashierDash.revenue_by_group_today, undefined,
      'by-group breakdown is manager/admin only');
    assert.equal(typeof cashierDash.revenue_cents, 'number');
  });

  await t.test('grouped CSV matches JSON: rows, totals, note as final row, filename', async () => {
    const rep = (await manager.call('GET', `/api/reports/sales?${rangeQ}&group_by=group`)).data;
    const csv = await manager.raw(`/api/reports/sales?${rangeQ}&group_by=group&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'),
      /filename="sales-by-group-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csv.text.trim().split('\n').map((l) => l.split(','));
    const sec = rep.sections[0];
    assert.deepEqual(lines[0], ['Sales by item group']);
    assert.deepEqual(lines[1], sec.columns);
    sec.rows.forEach((row, i) => {
      assert.deepEqual(lines[2 + i], sec.columns.map((c) => String(row[c] ?? '')));
    });
    assert.deepEqual(lines[2 + sec.rows.length], sec.columns.map((c) => String(sec.totals[c] ?? '')));
    assert.equal(csv.text.trim().split('\n').at(-1), sec.note, 'note is the trailing CSV row');
  });

  await t.test('security: authz matrix unchanged by group_by (JSON and CSV)', async () => {
    for (const p of ['/api/reports/sales?group_by=group', '/api/reports/admissions?group_by=group']) {
      assert.equal((await fetch(app.base + p)).status, 401, `anon 401 ${p}`);
      assert.equal((await cashier.call('GET', p)).status, 403, `cashier 403 ${p}`);
      assert.equal((await gate.call('GET', p)).status, 403, `gate 403 ${p}`);
      assert.equal((await cashier.raw(p + '&format=csv')).status, 403, `cashier 403 CSV ${p}`);
      assert.equal((await manager.call('GET', p)).status, 200, `manager 200 ${p}`);
    }
    assert.equal((await gate.call('GET', '/api/reports/dashboard')).status, 403);
  });

  await t.test('security: group_by fuzz → 400 bad_param, no side effects, no stack', async () => {
    const before = app.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    for (const v of ['bogus', "group'--", '1;DROP TABLE orders', 'GROUP']) {
      const r = await manager.call('GET',
        `/api/reports/sales?${rangeQ}&group_by=${encodeURIComponent(v)}`);
      assert.equal(r.status, 400, `400 for group_by=${v}`);
      assert.equal(r.data.error, 'bad_param');
      assert.equal(r.data.stack, undefined, 'no stack trace leaked');
      const ra = await manager.call('GET',
        `/api/reports/admissions?${rangeQ}&group_by=${encodeURIComponent(v)}`);
      assert.equal(ra.status, 400);
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before);
  });

  await t.test('security: hostile group names stay inert in JSON, CSV, and the filename', async () => {
    const evil = '"><script>alert(1)</script>, "x';
    const gEvil = (await admin.call('POST', '/api/groups', { name: evil, sort: 3 })).data.group;
    assert.equal((await admin.call('PUT', `/api/groups/${gEvil.id}/products`,
      { product_ids: [bySku.CHILD.id] })).status, 200);
    const rep = (await manager.call('GET', `/api/reports/sales?${rangeQ}&group_by=group`)).data;
    assert.ok(rep.sections[0].rows.some((r) => r.group === evil),
      'JSON returns the name verbatim as inert data');
    const csv = await manager.raw(`/api/reports/sales?${rangeQ}&group_by=group&format=csv`);
    assert.ok(csv.text.includes('"' + evil.replace(/"/g, '""') + '"'),
      'CSV cell is quoted with doubled quotes');
    assert.ok(!csv.headers.get('content-disposition').includes('script'),
      'filename never carries user text');

    // Formula-injection pin: sendCSV emits leading = raw (accepted: authoring needs
    // manager/admin). If sendCSV ever starts prefixing, update this pin deliberately.
    const gFormula = (await admin.call('POST', '/api/groups', { name: '=1+1', sort: 4 })).data.group;
    assert.equal((await admin.call('PUT', `/api/groups/${gFormula.id}/products`,
      { product_ids: [bySku.CHILD.id] })).status, 200);
    const csv2 = await manager.raw(`/api/reports/sales?${rangeQ}&group_by=group&format=csv`);
    assert.ok(csv2.text.split('\n').some((l) => l.startsWith('=1+1,')),
      'formula-like group name is emitted raw (pinned behavior)');
  });

  await t.test('security: range cap still enforced in group mode', async () => {
    const r = await manager.call('GET',
      '/api/reports/sales?from=2020-01-01&to=2026-01-01&group_by=group');
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'range_too_large');
    const ra = await manager.call('GET',
      '/api/reports/admissions?from=2020-01-01&to=2026-01-01&group_by=group');
    assert.equal(ra.data.error, 'range_too_large');
  });

  await t.test('grouped report over an empty range returns empty rows, not an error', async () => {
    const r = await manager.call('GET',
      '/api/reports/sales?from=2000-01-01&to=2000-01-01&group_by=group');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.sections[0].rows, []);
    const ra = await manager.call('GET',
      '/api/reports/admissions?from=2000-01-01&to=2000-01-01&group_by=group');
    assert.equal(ra.status, 200);
    assert.deepEqual(ra.data.sections[0].rows, []);
  });
});

// The live app always auto-mounts groups.js, so exercise the graceful-degradation
// guard by mounting reports directly with a ctx that lacks the groups module.
test('reports: group mode degrades to 400 groups_unavailable without the groups module', () => {
  const reports = require('../server/modules/reports');
  const handlers = new Map();
  const router = { get: (p, _roles, h) => handlers.set(p, h) };
  reports.mount(router, { db: null, modules: {} });
  for (const p of ['/api/reports/sales', '/api/reports/admissions']) {
    assert.throws(
      () => handlers.get(p)({ query: { group_by: 'group' }, user: { role: 'manager' } }, {}),
      (e) => e.status === 400 && e.code === 'groups_unavailable',
      `${p} should refuse group mode without the groups module`
    );
  }
});
