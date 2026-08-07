'use strict';
// reports — read-only aggregates over other modules' tables: the dashboard feed and
// five date-ranged reports (sales, product-mix, admissions, memberships, drawers),
// each also downloadable as CSV via ?format=csv. Sales and admissions additionally
// support ?group_by=group (rollup by item group via the groups.js exports). Never
// writes anything.
//
// Report JSON shape (uniform): { range: {from, to}, sections: [{ title, columns,
// rows, totals }] } — rows are objects keyed by `columns`; `totals` is one more row
// object rendered as the totals line; an optional `note` string is a footnote under
// the table. The CSV is generated from the SAME structure (note = trailing
// single-cell row), so table and CSV can never drift apart.
//
// Day bucketing is by LOCAL calendar day (SQLite date(ts,'localtime')), matching how
// the events module interprets date-only from/to and how admissions counts "today".
//
// Sales semantics (reconciliation contract, see spec):
//   gross = subtotal, net = gross - discounts (tax excluded, shown separately).
//   An order counts on its paid_at day even if later refunded — fully or per
//   line (history is immutable); each refund event (refunds table) shows up as
//   a NEGATIVE refund_cents on the day it happened.
//   payments_cents sums payment rows net of change, so per day+channel:
//   payments_cents = (net + tax of orders paid that day) + refund_cents of that day.
const { ApiError, sendCSV } = require('../core/http');
const { now } = require('../core/db');

const MANAGERS = ['manager', 'admin'];
const DAY_MS = (24 * 3600 * 1000);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DENIAL_REASONS = [
  'unknown', 'void', 'expired', 'not_yet_valid', 'exhausted', 'wrong_session_time', 'suspended',
];

// ---------- range handling (local days, inclusive) ----------

function localMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// from/to = local YYYY-MM-DD, inclusive; defaults to the last 14 days.
function parseRange(query) {
  let from = String(query.from || '');
  let to = String(query.to || '');
  if (to && !DATE_RE.test(to)) throw new ApiError(400, 'bad_range', 'to must be YYYY-MM-DD');
  if (from && !DATE_RE.test(from)) throw new ApiError(400, 'bad_range', 'from must be YYYY-MM-DD');
  if (!to) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    to = localDateStr(today);
  }
  if (!from) from = localDateStr(new Date(localMidnight(to).getTime() - 6 * DAY_MS));
  const fromDay = localMidnight(from);
  const toDay = localMidnight(to);
  if (toDay < fromDay) throw new ApiError(400, 'bad_range', 'to is before from');
  if ((toDay - fromDay) / DAY_MS > 366) {
    throw new ApiError(400, 'range_too_large', 'Range exceeds one year');
  }
  return {
    from,
    to,
    fromIso: fromDay.toISOString(),
    toIso: new Date(toDay.getTime() + DAY_MS).toISOString(), // exclusive upper bound
  };
}

// ---------- shared shaping ----------

function totalsOf(columns, rows, labelCol) {
  const totals = {};
  for (const c of columns) totals[c] = c === labelCol ? 'TOTAL' : '';
  for (const r of rows) {
    for (const c of columns) {
      if (typeof r[c] === 'number') totals[c] = (totals[c] === '' ? 0 : totals[c]) + r[c];
    }
  }
  return totals;
}

function toCsvRows(report) {
  const out = [];
  report.sections.forEach((s, i) => {
    if (i > 0) out.push(['']);
    if (s.title) out.push([s.title]);
    out.push(s.columns);
    for (const r of s.rows) out.push(s.columns.map((c) => r[c] ?? ''));
    if (s.totals) out.push(s.columns.map((c) => s.totals[c] ?? ''));
    if (s.note) out.push([s.note]); // footnote travels with the CSV too
  });
  return out;
}

// Handler wrapper: JSON by default, CSV when ?format=csv.
function respond(req, res, name, report) {
  if (req.query.format === 'csv') {
    sendCSV(res, `${name}-${report.range.from}-to-${report.range.to}.csv`, toCsvRows(report));
    return undefined;
  }
  return report;
}

// ---------- sales summary ----------

function salesReport(db, rng) {
  const columns = [
    'date', 'channel', 'orders', 'units', 'gross_cents', 'discount_cents',
    'tax_cents', 'net_cents', 'refunds', 'refund_cents', 'payments_cents',
  ];
  const map = new Map();
  const rowFor = (date, channel) => {
    const k = `${date}|${channel}`;
    if (!map.has(k)) {
      map.set(k, {
        date, channel, orders: 0, units: 0, gross_cents: 0, discount_cents: 0,
        tax_cents: 0, net_cents: 0, refunds: 0, refund_cents: 0, payments_cents: 0,
      });
    }
    return map.get(k);
  };

  // Sales activity keyed by the day the order was PAID (immutable history: a later
  // refund never rewrites the sale day).
  for (const r of db.prepare(
    `SELECT date(o.paid_at, 'localtime') AS day, o.channel,
            COUNT(*) AS orders,
            COALESCE(SUM((SELECT SUM(ol.qty) FROM order_lines ol WHERE ol.order_id = o.id)), 0) AS units,
            COALESCE(SUM(o.subtotal_cents), 0) AS gross,
            COALESCE(SUM(o.discount_cents), 0) AS disc,
            COALESCE(SUM(o.tax_cents), 0) AS tax
     FROM orders o
     WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded', 'partial_refund')
     GROUP BY day, o.channel`
  ).all(rng.fromIso, rng.toIso)) {
    const row = rowFor(r.day, r.channel);
    row.orders += r.orders;
    row.units += r.units;
    row.gross_cents += r.gross;
    row.discount_cents += r.disc;
    row.tax_cents += r.tax;
  }

  // Refund events (full or partial) keyed by the day they happened, as negatives.
  for (const r of db.prepare(
    `SELECT date(rf.created_at, 'localtime') AS day, o.channel,
            COUNT(*) AS n, COALESCE(SUM(rf.total_cents), 0) AS total
     FROM refunds rf JOIN orders o ON o.id = rf.order_id
     WHERE rf.created_at >= ? AND rf.created_at < ?
     GROUP BY day, o.channel`
  ).all(rng.fromIso, rng.toIso)) {
    const row = rowFor(r.day, r.channel);
    row.refunds += r.n;
    row.refund_cents -= r.total;
  }

  // Money actually taken/returned per day (payment rows net of change; refund rows
  // are already negative).
  for (const r of db.prepare(
    `SELECT date(p.created_at, 'localtime') AS day, o.channel,
            COALESCE(SUM(p.amount_cents - p.change_cents), 0) AS paid
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.created_at >= ? AND p.created_at < ?
     GROUP BY day, o.channel`
  ).all(rng.fromIso, rng.toIso)) {
    rowFor(r.day, r.channel).payments_cents += r.paid;
  }

  const rows = [...map.values()].sort((a, b) =>
    a.date === b.date ? a.channel.localeCompare(b.channel) : a.date < b.date ? -1 : 1
  );
  for (const r of rows) r.net_cents = r.gross_cents - r.discount_cents;
  return {
    range: { from: rng.from, to: rng.to },
    sections: [{ title: 'Sales summary', columns, rows, totals: totalsOf(columns, rows, 'date') }],
  };
}

// ---------- group rollups (sales / admissions by item group) ----------

// Multi-group products count in every group they belong to (disclosed in the note),
// so group totals may exceed the grand total. The disclosure sentence ships in both
// the JSON section and the CSV so exports stay self-explaining.
const MULTI_GROUP_NOTE =
  'Products in multiple groups count in each group; group totals can exceed the grand ' +
  'total. Ungrouped = products in no active group.';

// Map product id -> active groups, via the frozen groups.js exports only (they encode
// the active-only / deactivation semantics — never re-query item_groups from here).
function groupIndex(db, groups) {
  const list = groups.listGroups(db); // active only, sorted by sort, name, id
  const byProduct = new Map();
  for (const g of list) {
    for (const pid of groups.productIdsInGroup(db, g.id)) {
      if (!byProduct.has(pid)) byProduct.set(pid, []);
      byProduct.get(pid).push(g);
    }
  }
  return { list, byProduct };
}

// Fan per-product aggregate rows out to one bucket per group (or Ungrouped), summing
// the numeric columns. Returns rows in listGroups order, Ungrouped last if nonzero.
function distributeByGroup(idx, perProduct, numericCols, makeRow) {
  const acc = new Map(); // group id | 'ungrouped' -> row
  const rowFor = (key, label) => {
    if (!acc.has(key)) acc.set(key, makeRow(label));
    return acc.get(key);
  };
  for (const p of perProduct) {
    const gs = idx.byProduct.get(p.product_id);
    const targets = gs && gs.length
      ? gs.map((g) => [g.id, g.name])
      : [['ungrouped', 'Ungrouped']];
    for (const [key, label] of targets) {
      const row = rowFor(key, label);
      for (const c of numericCols) row[c] += p[c];
    }
  }
  const rows = idx.list.filter((g) => acc.has(g.id)).map((g) => acc.get(g.id));
  if (acc.has('ungrouped')) rows.push(acc.get('ungrouped'));
  return rows;
}

function salesByGroupReport(db, groups, rng) {
  const columns = ['group', 'units', 'gross_cents', 'discount_cents', 'tax_cents', 'net_cents'];
  // Per-product line aggregates over the same population as the sales summary /
  // product mix (paid-day keyed, refunded orders still count on their paid day).
  // Line-level discount/tax are exact integer-cent allocations (see pos.js), so
  // per-group net = gross − discount reconciles to the penny.
  const perProduct = db.prepare(
    `SELECT ol.product_id,
            SUM(ol.qty) AS units,
            SUM(ol.qty * ol.unit_price_cents) AS gross_cents,
            SUM(ol.discount_cents) AS discount_cents,
            SUM(ol.tax_cents) AS tax_cents
     FROM order_lines ol
     JOIN orders o ON o.id = ol.order_id
     WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded', 'partial_refund')
     GROUP BY ol.product_id`
  ).all(rng.fromIso, rng.toIso);
  const rows = distributeByGroup(
    groupIndex(db, groups), perProduct,
    ['units', 'gross_cents', 'discount_cents', 'tax_cents'],
    (label) => ({ group: label, units: 0, gross_cents: 0, discount_cents: 0, tax_cents: 0 })
  );
  for (const r of rows) r.net_cents = r.gross_cents - r.discount_cents;
  return {
    range: { from: rng.from, to: rng.to },
    sections: [{
      title: 'Sales by item group', columns, rows,
      totals: totalsOf(columns, rows, 'group'), note: MULTI_GROUP_NOTE,
    }],
  };
}

function admissionsByGroupReport(db, groups, rng) {
  const columns = ['group', 'scans', 'admits', 'denied'];
  // Only ticket scans carry a product; member/unknown scans (ticket_id NULL) are
  // counted in the note, never itemized (no holder/member data in this report).
  const perProduct = db.prepare(
    `SELECT t.product_id, COUNT(*) AS scans,
            COALESCE(SUM(a.result = 'ok'), 0) AS admits,
            COALESCE(SUM(a.result = 'denied'), 0) AS denied
     FROM admits a JOIN tickets t ON t.id = a.ticket_id
     WHERE a.at >= ? AND a.at < ?
     GROUP BY t.product_id`
  ).all(rng.fromIso, rng.toIso);
  const rows = distributeByGroup(
    groupIndex(db, groups), perProduct,
    ['scans', 'admits', 'denied'],
    (label) => ({ group: label, scans: 0, admits: 0, denied: 0 })
  );
  const nonTicket = db.prepare(
    'SELECT COUNT(*) AS n FROM admits WHERE at >= ? AND at < ? AND ticket_id IS NULL'
  ).get(rng.fromIso, rng.toIso).n;
  const note = MULTI_GROUP_NOTE + (nonTicket
    ? ` ${nonTicket} member/unknown scan(s) have no ticket product and are not grouped.`
    : '');
  return {
    range: { from: rng.from, to: rng.to },
    sections: [{
      title: 'Admissions by item group', columns, rows,
      totals: totalsOf(columns, rows, 'group'), note,
    }],
  };
}

// ---------- product mix ----------

function productMixReport(db, rng) {
  const columns = ['product', 'sku', 'kind', 'units', 'gross_cents', 'share_pct'];
  const rows = db.prepare(
    `SELECT p.name AS product, p.sku, p.kind,
            SUM(ol.qty) AS units,
            SUM(ol.qty * ol.unit_price_cents) AS gross_cents
     FROM order_lines ol
     JOIN orders o ON o.id = ol.order_id
     JOIN products p ON p.id = ol.product_id
     WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded', 'partial_refund')
     GROUP BY ol.product_id
     ORDER BY gross_cents DESC, p.name`
  ).all(rng.fromIso, rng.toIso);
  const totalGross = rows.reduce((a, r) => a + r.gross_cents, 0);
  for (const r of rows) {
    r.share_pct = totalGross > 0 ? Math.round((r.gross_cents / totalGross) * 1000) / 10 : 0;
  }
  const totals = totalsOf(columns, rows, 'product');
  if (rows.length) totals.share_pct = Math.round(totals.share_pct * 10) / 10;
  return {
    range: { from: rng.from, to: rng.to },
    sections: [{ title: 'Product mix', columns, rows, totals }],
  };
}

// ---------- admissions ----------

function admissionsReport(db, rng) {
  const dayColumns = ['date', 'scans', 'admits', 'denied', ...DENIAL_REASONS];
  const reasonSums = DENIAL_REASONS.map(
    (r) => `COALESCE(SUM(a.result = 'denied' AND a.reason = '${r}'), 0) AS ${r}`
  ).join(', ');
  const dayRows = db.prepare(
    `SELECT date(a.at, 'localtime') AS date, COUNT(*) AS scans,
            COALESCE(SUM(a.result = 'ok'), 0) AS admits,
            COALESCE(SUM(a.result = 'denied'), 0) AS denied, ${reasonSums}
     FROM admits a WHERE a.at >= ? AND a.at < ?
     GROUP BY date ORDER BY date`
  ).all(rng.fromIso, rng.toIso);

  const gateColumns = ['gate', 'scans', 'admits', 'denied'];
  const gateRows = db.prepare(
    `SELECT a.gate, COUNT(*) AS scans,
            COALESCE(SUM(a.result = 'ok'), 0) AS admits,
            COALESCE(SUM(a.result = 'denied'), 0) AS denied
     FROM admits a WHERE a.at >= ? AND a.at < ?
     GROUP BY a.gate ORDER BY a.gate`
  ).all(rng.fromIso, rng.toIso);

  return {
    range: { from: rng.from, to: rng.to },
    sections: [
      { title: 'Admissions by day', columns: dayColumns, rows: dayRows,
        totals: totalsOf(dayColumns, dayRows, 'date') },
      { title: 'Admissions by gate', columns: gateColumns, rows: gateRows,
        totals: totalsOf(gateColumns, gateRows, 'gate') },
    ],
  };
}

// ---------- memberships ----------

function membershipsReport(db, rng) {
  const columns = [
    'program', 'units_sold', 'new_members', 'renewals', 'active_members', 'expiring_30d',
  ];
  const nowIso = now();
  const in30 = new Date(Date.parse(nowIso) + 30 * DAY_MS).toISOString();
  const rows = db.prepare(
    `SELECT pr.name AS program,
            COALESCE((SELECT SUM(ol.qty)
              FROM order_lines ol
              JOIN orders o ON o.id = ol.order_id
              JOIN products p ON p.id = ol.product_id
              WHERE p.membership_program_id = pr.id
                AND o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded', 'partial_refund')), 0) AS units_sold,
            (SELECT COUNT(*) FROM members m
              WHERE m.program_id = pr.id AND m.joined_at >= ? AND m.joined_at < ?) AS new_members,
            (SELECT COUNT(*) FROM members m
              WHERE m.program_id = pr.id AND m.status = 'active' AND m.expires_at > ?) AS active_members,
            (SELECT COUNT(*) FROM members m
              WHERE m.program_id = pr.id AND m.status = 'active'
                AND m.expires_at > ? AND m.expires_at <= ?) AS expiring_30d
     FROM membership_programs pr ORDER BY pr.name`
  ).all(rng.fromIso, rng.toIso, rng.fromIso, rng.toIso, nowIso, nowIso, in30);
  // Renewals = membership units sold in range that did not create a new member row.
  for (const r of rows) r.renewals = Math.max(0, r.units_sold - r.new_members);
  return {
    range: { from: rng.from, to: rng.to },
    sections: [{ title: 'Memberships', columns, rows, totals: totalsOf(columns, rows, 'program') }],
  };
}

// ---------- drawer sessions ----------

// Closed drawer sessions in range (bucketed by local close day) plus an
// "Unattributed POS cash" cross-check: cash payments on pos-channel orders with
// no drawer_session_id. With enforcement live that line should be 0 — anything
// else is pre-drawer history or a refund taken without an open drawer.
function drawersReport(db, rng) {
  const columns = [
    'date', 'z_number', 'cashier', 'terminal', 'float_cents', 'cash_cents',
    'paid_in_cents', 'paid_out_cents', 'expected_cents', 'counted_cents',
    'over_short_cents',
  ];
  const rows = db.prepare(
    `SELECT date(ds.closed_at, 'localtime') AS date, ds.z_number,
            u.display_name AS cashier, ds.terminal,
            ds.open_float_cents AS float_cents,
            COALESCE((SELECT SUM(p.amount_cents - p.change_cents) FROM payments p
               WHERE p.drawer_session_id = ds.id AND p.method = 'cash'), 0) AS cash_cents,
            COALESCE((SELECT SUM(m.amount_cents) FROM drawer_movements m
               WHERE m.drawer_session_id = ds.id AND m.kind = 'paid_in'), 0) AS paid_in_cents,
            COALESCE((SELECT SUM(m.amount_cents) FROM drawer_movements m
               WHERE m.drawer_session_id = ds.id AND m.kind = 'paid_out'), 0) AS paid_out_cents,
            ds.expected_cents, ds.counted_cents, ds.over_short_cents
     FROM drawer_sessions ds JOIN users u ON u.id = ds.opened_by
     WHERE ds.status = 'closed' AND ds.closed_at >= ? AND ds.closed_at < ?
     ORDER BY ds.closed_at`
  ).all(rng.fromIso, rng.toIso);
  const totals = totalsOf(columns, rows, 'date');
  totals.z_number = ''; // summing Z numbers is meaningless

  const un = db.prepare(
    `SELECT COUNT(*) AS payments,
            COALESCE(SUM(p.amount_cents - p.change_cents), 0) AS amount_cents
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.method = 'cash' AND p.drawer_session_id IS NULL AND o.channel = 'pos'
       AND p.created_at >= ? AND p.created_at < ?`
  ).get(rng.fromIso, rng.toIso);
  const unColumns = ['item', 'payments', 'amount_cents'];
  const unRows = [{ item: 'Unattributed POS cash', payments: un.payments, amount_cents: un.amount_cents }];

  return {
    range: { from: rng.from, to: rng.to },
    sections: [
      { title: 'Closed drawer sessions', columns, rows, totals },
      { title: 'Unattributed POS cash', columns: unColumns, rows: unRows },
    ],
  };
}

// ---------- dashboard ----------

function dashboard(db, groups) {
  const nowIso = now();
  const dayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();

  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const revenue_cents = one(
    'SELECT COALESCE(SUM(amount_cents - change_cents), 0) AS n FROM payments WHERE created_at >= ?',
    dayStart
  );
  const orders_today = one(
    "SELECT COUNT(*) AS n FROM orders WHERE paid_at >= ? AND status IN ('paid', 'refunded', 'partial_refund')",
    dayStart
  );
  const tickets_sold_today = one(
    'SELECT COUNT(*) AS n FROM tickets WHERE valid_from >= ?', dayStart
  );
  const admits_ok_today = one(
    "SELECT COUNT(*) AS n FROM admits WHERE at >= ? AND result = 'ok'", dayStart
  );
  const admits_denied_today = one(
    "SELECT COUNT(*) AS n FROM admits WHERE at >= ? AND result = 'denied'", dayStart
  );
  const members_active = one(
    "SELECT COUNT(*) AS n FROM members WHERE status = 'active' AND expires_at > ?", nowIso
  );
  const next_sessions = db.prepare(
    `SELECT s.id, e.name AS event_name, s.starts_at, s.ends_at, s.capacity, s.sold
     FROM event_sessions s JOIN events e ON e.id = s.event_id
     WHERE s.cancelled = 0 AND s.ends_at >= ?
     ORDER BY s.starts_at LIMIT 5`
  ).all(nowIso).map((s) => ({
    ...s,
    remaining: s.capacity - s.sold,
    fill_pct: s.capacity > 0 ? Math.round((s.sold / s.capacity) * 100) : 0,
  }));

  const out = {
    as_of: nowIso,
    revenue_cents,
    orders_today,
    tickets_sold_today,
    admits_ok_today,
    admits_denied_today,
    in_park_estimate: admits_ok_today,
    members_active,
    next_sessions,
  };

  // Sales by group today, top 5 + Ungrouped. SALES-based (order lines of orders paid
  // today, gross − discount + tax), NOT payments-based like revenue_cents — payments
  // aren't line-attributed, so the two won't tie out on refund days.
  if (groups) {
    const idx = groupIndex(db, groups);
    const perProduct = db.prepare(
      `SELECT ol.product_id,
              SUM(ol.qty * ol.unit_price_cents - ol.discount_cents + ol.tax_cents) AS revenue_cents
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id
       WHERE o.paid_at >= ? AND o.status IN ('paid', 'refunded', 'partial_refund')
       GROUP BY ol.product_id`
    ).all(dayStart);
    const rows = distributeByGroup(idx, perProduct, ['revenue_cents'],
      (label) => ({ group: label, revenue_cents: 0 }));
    // Ungrouped bucket (when present) is always the last row from distributeByGroup.
    const hasUngrouped = perProduct.some((p) => !(idx.byProduct.get(p.product_id) || []).length);
    const ungrouped = hasUngrouped ? rows[rows.length - 1] : null;
    const grouped = rows.filter((r) => r !== ungrouped)
      .sort((a, b) => b.revenue_cents - a.revenue_cents)
      .slice(0, 5);
    out.revenue_by_group_today = ungrouped ? [...grouped, ungrouped] : grouped;
  }

  return out;
}

// ---------- mount ----------

function mount(router, ctx) {
  const db = ctx.db;

  // Soft dependency on the item-groups module (present via auto-mount; guarded like
  // menus/storefront so group mode degrades to a clean 400 if it's ever absent).
  const groupsMod = ctx.modules?.groups;
  const hasGroups = Boolean(groupsMod
    && typeof groupsMod.listGroups === 'function'
    && typeof groupsMod.productIdsInGroup === 'function');

  // Strict allowlist: absent/'' = plain report, 'group' = group mode, else 400.
  // Never alters authz — the role gate runs before the handler either way.
  const groupMode = (req) => {
    const mode = String(req.query.group_by || '');
    if (!mode) return false;
    if (mode !== 'group') throw new ApiError(400, 'bad_param', 'group_by must be "group"');
    if (!hasGroups) {
      throw new ApiError(400, 'groups_unavailable', 'The item-groups module is not available');
    }
    return true;
  };

  // Sellers and up only: today's revenue/KPIs are outside the gate role's scope
  // (gate sees Admissions only — an entrance device must never surface financials).
  router.get('/api/reports/dashboard', ['cashier', 'manager', 'admin'], (req) =>
    dashboard(db, hasGroups && MANAGERS.includes(req.user.role) ? groupsMod : null));

  router.get('/api/reports/sales', MANAGERS, (req, res) => {
    const rng = parseRange(req.query);
    return groupMode(req)
      ? respond(req, res, 'sales-by-group', salesByGroupReport(db, groupsMod, rng))
      : respond(req, res, 'sales', salesReport(db, rng));
  });

  router.get('/api/reports/product-mix', MANAGERS, (req, res) =>
    respond(req, res, 'product-mix', productMixReport(db, parseRange(req.query))));

  router.get('/api/reports/admissions', MANAGERS, (req, res) => {
    const rng = parseRange(req.query);
    return groupMode(req)
      ? respond(req, res, 'admissions-by-group', admissionsByGroupReport(db, groupsMod, rng))
      : respond(req, res, 'admissions', admissionsReport(db, rng));
  });

  router.get('/api/reports/memberships', MANAGERS, (req, res) =>
    respond(req, res, 'memberships', membershipsReport(db, parseRange(req.query))));

  router.get('/api/reports/drawers', MANAGERS, (req, res) =>
    respond(req, res, 'drawers', drawersReport(db, parseRange(req.query))));
}

// parseRange/toCsvRows are additively exported for the drawer module (session
// list ranges + Z-report CSVs) so range semantics and CSV shaping cannot drift.
module.exports = { mount, parseRange, toCsvRows };
