'use strict';
// reports — read-only aggregates over other modules' tables: the dashboard feed and
// four date-ranged reports (sales, product-mix, admissions, memberships), each also
// downloadable as CSV via ?format=csv. Never writes anything.
//
// Report JSON shape (uniform): { range: {from, to}, sections: [{ title, columns,
// rows, totals }] } — rows are objects keyed by `columns`; `totals` is one more row
// object rendered as the totals line. The CSV is generated from the SAME structure,
// so table and CSV can never drift apart.
//
// Day bucketing is by LOCAL calendar day (SQLite date(ts,'localtime')), matching how
// the events module interprets date-only from/to and how admissions counts "today".
//
// Sales semantics (reconciliation contract, see spec):
//   gross = subtotal, net = gross - discounts (tax excluded, shown separately).
//   An order counts on its paid_at day even if later refunded (history is immutable);
//   the refund shows up as a NEGATIVE refund_cents on the refunded_at day.
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
     WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded')
     GROUP BY day, o.channel`
  ).all(rng.fromIso, rng.toIso)) {
    const row = rowFor(r.day, r.channel);
    row.orders += r.orders;
    row.units += r.units;
    row.gross_cents += r.gross;
    row.discount_cents += r.disc;
    row.tax_cents += r.tax;
  }

  // Refunds keyed by the day they happened, as negatives.
  for (const r of db.prepare(
    `SELECT date(o.refunded_at, 'localtime') AS day, o.channel,
            COUNT(*) AS n, COALESCE(SUM(o.total_cents), 0) AS total
     FROM orders o
     WHERE o.refunded_at >= ? AND o.refunded_at < ? AND o.status = 'refunded'
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
     WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded')
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
                AND o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded')), 0) AS units_sold,
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

// ---------- dashboard ----------

function dashboard(db) {
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
    "SELECT COUNT(*) AS n FROM orders WHERE paid_at >= ? AND status IN ('paid', 'refunded')",
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

  return {
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
}

// ---------- mount ----------

function mount(router, ctx) {
  const db = ctx.db;

  router.get('/api/reports/dashboard', [], () => dashboard(db));

  router.get('/api/reports/sales', MANAGERS, (req, res) =>
    respond(req, res, 'sales', salesReport(db, parseRange(req.query))));

  router.get('/api/reports/product-mix', MANAGERS, (req, res) =>
    respond(req, res, 'product-mix', productMixReport(db, parseRange(req.query))));

  router.get('/api/reports/admissions', MANAGERS, (req, res) =>
    respond(req, res, 'admissions', admissionsReport(db, parseRange(req.query))));

  router.get('/api/reports/memberships', MANAGERS, (req, res) =>
    respond(req, res, 'memberships', membershipsReport(db, parseRange(req.query))));
}

module.exports = { mount };
