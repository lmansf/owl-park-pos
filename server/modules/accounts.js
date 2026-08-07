'use strict';
// accounts — chart of accounts, activity→GL mappings, and a derived daily journal.
// Self-initializes a default chart + default mappings on mount when `accounts` is
// empty (fresh installs AND databases that predate this module both get a working
// chart with zero manual setup). The journal is a READ-ONLY derivation over
// payments / orders / order_lines / products / discounts — nothing is written at
// report time, and no other module's rows are ever mutated here.
//
// Posting model per paid order (on its paid_at LOCAL day, matching reports.js):
//   Dr  tender clearing    payment rows net of change (pos writes refunds as
//                          negative rows, so the clearing side of a refund
//                          reverses automatically on the refund date)
//   Dr  discounts account  order discount_cents, per discount mapping
//   Cr  income account     line gross (qty * unit_price) per product mapping
//   Cr  tax liability      line tax_cents per tax-group mapping
// clearing debit = subtotal - discount + tax, and discounts debit = discount, so
// debits = subtotal + tax = income gross + tax = credits: balanced by construction.
// A refund event (refunds/refund_lines, full or per-line) posts the reversal of
// exactly the refunded slice of the income/tax/discount legs on the day it
// happened (Dr income, Dr tax, Cr discounts) — per refund event
// total = gross - discount + tax, so it balances against that event's negative
// payment rows. Activity with no mapping posts to suspense account
// 9999 "Unmapped" so it stays visible and the books still balance.
const { ApiError, sendCSV, toInt } = require('../core/http');
const { tx } = require('../core/db');
const { audit } = require('../core/auth');

const MANAGERS = ['manager', 'admin'];
const KINDS = ['asset', 'liability', 'income', 'expense', 'clearing'];
const SCOPES = ['product', 'tax_group', 'tender', 'discount'];
const SUSPENSE_CODE = '9999';
const DAY_MS = 24 * 3600 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_CHART = [
  ['1000', 'Cash Clearing', 'clearing'],
  ['1010', 'Card Clearing', 'clearing'],
  ['1020', 'Voucher Clearing', 'clearing'],
  ['2200', 'Sales Tax Payable', 'liability'],
  ['4000', 'Admission Income', 'income'],
  ['4100', 'Membership Income', 'income'],
  ['4200', 'Addon Income', 'income'],
  ['4900', 'Discounts Given', 'expense'],
  [SUSPENSE_CODE, 'Unmapped', 'clearing'],
];
// Tender method (pos registry key) → default clearing account. The valid method
// set itself comes from ctx.modules.pos.listTenders() at mount, not from here —
// a registry tender without a row here simply starts unmapped (suspense 9999).
const TENDER_DEFAULTS = { cash: '1000', card_sim: '1010', voucher: '1020' };
const KIND_INCOME = { ticket: '4000', membership: '4100', addon: '4200' };

function bad(message) {
  return new ApiError(400, 'bad_request', message);
}

// ---------- self-init ----------

// Seed the default chart + sensible mappings when the accounts table is empty;
// always guarantee the 9999 suspense account exists. Idempotent, runs at mount.
function ensureChart(db) {
  tx(db, () => {
    const empty = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n === 0;
    if (empty) {
      const ins = db.prepare('INSERT INTO accounts (code, name, kind) VALUES (?, ?, ?)');
      for (const [code, name, kind] of DEFAULT_CHART) ins.run(code, name, kind);

      const idByCode = {};
      for (const a of db.prepare('SELECT id, code FROM accounts').all()) idByCode[a.code] = a.id;
      const map = db.prepare(
        `INSERT INTO account_map (scope, ref_key, account_id) VALUES (?, ?, ?)
         ON CONFLICT(scope, ref_key) DO NOTHING`
      );
      for (const [method, code] of Object.entries(TENDER_DEFAULTS)) {
        map.run('tender', method, idByCode[code]);
      }
      for (const t of db.prepare('SELECT id FROM tax_groups').all()) {
        map.run('tax_group', String(t.id), idByCode['2200']);
      }
      for (const p of db.prepare('SELECT id, kind FROM products').all()) {
        map.run('product', String(p.id), idByCode[KIND_INCOME[p.kind] || '4200']);
      }
      for (const d of db.prepare('SELECT id FROM discounts').all()) {
        map.run('discount', String(d.id), idByCode['4900']);
      }
    } else {
      if (!db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(SUSPENSE_CODE)) {
        db.prepare('INSERT INTO accounts (code, name, kind) VALUES (?, ?, ?)')
          .run(SUSPENSE_CODE, 'Unmapped', 'clearing');
      }
      // Databases seeded before a tender existed get its default clearing
      // account + mapping too. Only when the account CODE is absent: an admin
      // who deliberately cleared a mapping (account still present) is respected.
      for (const [method, code] of Object.entries(TENDER_DEFAULTS)) {
        if (db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(code)) continue;
        const [, name, kind] = DEFAULT_CHART.find(([c]) => c === code);
        const info = db
          .prepare('INSERT INTO accounts (code, name, kind) VALUES (?, ?, ?)')
          .run(code, name, kind);
        db.prepare(
          `INSERT INTO account_map (scope, ref_key, account_id) VALUES ('tender', ?, ?)
           ON CONFLICT(scope, ref_key) DO NOTHING`
        ).run(method, Number(info.lastInsertRowid));
      }
    }
  });
}

// ---------- range handling (local days, inclusive — same semantics as reports) ----------

function localMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
    toIso: new Date(toDay.getTime() + DAY_MS).toISOString(),
  };
}

// ---------- shared report shaping (same structure as reports.js) ----------

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

function respond(req, res, name, report) {
  if (req.query.format === 'csv') {
    sendCSV(res, `${name}-${report.range.from}-to-${report.range.to}.csv`, toCsvRows(report));
    return undefined;
  }
  return report;
}

// ---------- journal derivation ----------

function journalReport(db, rng) {
  const accounts = db.prepare('SELECT * FROM accounts').all();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const suspense = accounts.find((a) => a.code === SUSPENSE_CODE) || null;
  const maps = { product: new Map(), tax_group: new Map(), tender: new Map(), discount: new Map() };
  for (const m of db.prepare('SELECT scope, ref_key, account_id FROM account_map').all()) {
    maps[m.scope].set(String(m.ref_key), m.account_id);
  }
  const acctFor = (scope, key) => byId.get(maps[scope].get(String(key))) || suspense;

  const cells = new Map(); // `${day}|${account.id}` → {date, account, debit, credit}
  function post(day, account, debit, credit) {
    if (!account || (!debit && !credit)) return;
    const k = `${day}|${account.id}`;
    if (!cells.has(k)) cells.set(k, { date: day, account, debit: 0, credit: 0 });
    const c = cells.get(k);
    c.debit += debit;
    c.credit += credit;
  }

  // 1) Tender clearing: payment rows net of change. Refund rows are negative
  //    (pos convention), which lands as a credit on the refund date.
  for (const p of db.prepare(
    `SELECT date(created_at, 'localtime') AS day, method,
            amount_cents - change_cents AS net
     FROM payments WHERE created_at >= ? AND created_at < ?`
  ).all(rng.fromIso, rng.toIso)) {
    const a = acctFor('tender', p.method);
    if (p.net >= 0) post(p.day, a, p.net, 0);
    else post(p.day, a, 0, -p.net);
  }

  // 2) Sale legs on the paid_at day (immutable history — refunds never rewrite it).
  const saleLines = db.prepare(
    `SELECT date(o.paid_at, 'localtime') AS day, ol.product_id, pr.tax_group_id,
            SUM(ol.qty * ol.unit_price_cents) AS gross, SUM(ol.tax_cents) AS tax
     FROM order_lines ol
     JOIN orders o ON o.id = ol.order_id
     JOIN products pr ON pr.id = ol.product_id
     WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded', 'partial_refund')
     GROUP BY day, ol.product_id`
  ).all(rng.fromIso, rng.toIso);
  for (const l of saleLines) {
    post(l.day, acctFor('product', l.product_id), 0, l.gross);
    post(l.day, acctFor('tax_group', l.tax_group_id), 0, l.tax);
  }

  const saleDiscounts = db.prepare(
    `SELECT date(o.paid_at, 'localtime') AS day, d.id AS discount_id,
            SUM(o.discount_cents) AS disc
     FROM orders o LEFT JOIN discounts d ON d.code = o.discount_code
     WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid', 'refunded', 'partial_refund')
       AND o.discount_cents > 0
     GROUP BY day, d.id`
  ).all(rng.fromIso, rng.toIso);
  for (const r of saleDiscounts) {
    post(r.day, acctFor('discount', r.discount_id), r.disc, 0);
  }

  // 3) Refund reversals on the day each refund event happened, at refund_lines
  //    granularity (clearing side is already handled by the negative payment
  //    rows in step 1).
  const refundLines = db.prepare(
    `SELECT date(rf.created_at, 'localtime') AS day, ol.product_id, pr.tax_group_id,
            SUM(rl.gross_cents) AS gross, SUM(rl.tax_cents) AS tax
     FROM refund_lines rl
     JOIN refunds rf ON rf.id = rl.refund_id
     JOIN order_lines ol ON ol.id = rl.order_line_id
     JOIN products pr ON pr.id = ol.product_id
     WHERE rf.created_at >= ? AND rf.created_at < ?
     GROUP BY day, ol.product_id`
  ).all(rng.fromIso, rng.toIso);
  for (const l of refundLines) {
    post(l.day, acctFor('product', l.product_id), l.gross, 0);
    post(l.day, acctFor('tax_group', l.tax_group_id), l.tax, 0);
  }

  const refundDiscounts = db.prepare(
    `SELECT date(rf.created_at, 'localtime') AS day, d.id AS discount_id,
            SUM(rl.discount_cents) AS disc
     FROM refund_lines rl
     JOIN refunds rf ON rf.id = rl.refund_id
     JOIN orders o ON o.id = rf.order_id
     LEFT JOIN discounts d ON d.code = o.discount_code
     WHERE rf.created_at >= ? AND rf.created_at < ? AND rl.discount_cents > 0
     GROUP BY day, d.id`
  ).all(rng.fromIso, rng.toIso);
  for (const r of refundDiscounts) {
    post(r.day, acctFor('discount', r.discount_id), 0, r.disc);
  }

  // ---- shape: journal lines + per-day totals ----
  const columns = ['date', 'code', 'account', 'kind', 'debit_cents', 'credit_cents'];
  const rows = [...cells.values()]
    .sort((a, b) =>
      a.date === b.date
        ? a.account.code.localeCompare(b.account.code)
        : a.date < b.date ? -1 : 1
    )
    .map((c) => ({
      date: c.date,
      code: c.account.code,
      account: c.account.name,
      kind: c.account.kind,
      debit_cents: c.debit,
      credit_cents: c.credit,
    }));

  const dayColumns = ['date', 'debit_cents', 'credit_cents', 'difference_cents'];
  const perDay = new Map();
  for (const r of rows) {
    if (!perDay.has(r.date)) {
      perDay.set(r.date, { date: r.date, debit_cents: 0, credit_cents: 0, difference_cents: 0 });
    }
    const d = perDay.get(r.date);
    d.debit_cents += r.debit_cents;
    d.credit_cents += r.credit_cents;
    d.difference_cents = d.debit_cents - d.credit_cents;
  }
  const dayRows = [...perDay.values()];

  return {
    range: { from: rng.from, to: rng.to },
    sections: [
      { title: 'Journal', columns, rows, totals: totalsOf(columns, rows, 'date') },
      { title: 'Daily totals', columns: dayColumns, rows: dayRows,
        totals: totalsOf(dayColumns, dayRows, 'date') },
    ],
  };
}

// ---------- account + mapping validation ----------

function accountPayload(db, body, existing) {
  const src = { ...(existing || {}), ...(body || {}) };
  const code = String(src.code ?? '').trim();
  if (!code) throw bad('code is required');
  const name = String(src.name ?? '').trim();
  if (!name) throw bad('name is required');
  if (!KINDS.includes(src.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  const active = src.active === 0 || src.active === false || src.active === '0' ? 0 : 1;
  if (existing && existing.code === SUSPENSE_CODE && code !== SUSPENSE_CODE) {
    throw bad(`account ${SUSPENSE_CODE} is the suspense account — its code cannot change`);
  }
  const dupe = db.prepare('SELECT id FROM accounts WHERE code = ?').get(code);
  if (dupe && (!existing || dupe.id !== existing.id)) {
    throw new ApiError(409, 'code_taken', `Account code "${code}" already exists`);
  }
  return { code, name, kind: src.kind, active };
}

function validateRefKey(db, scope, refKey, tenderMethods) {
  if (scope === 'tender') {
    const key = String(refKey ?? '').trim();
    if (!key) throw bad('ref_key is required');
    if (!tenderMethods.includes(key)) {
      throw bad(`tender must be one of ${tenderMethods.join(', ')}`);
    }
    return key;
  }
  const table = { product: 'products', tax_group: 'tax_groups', discount: 'discounts' }[scope];
  const n = toInt(refKey, 'ref_key', { min: 1 });
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(n)) {
    throw bad(`no ${scope} with id ${refKey}`);
  }
  return String(n);
}

// ---------- mount ----------

function mount(router, ctx) {
  const db = ctx.db;
  ensureChart(db);
  // ctx.modules is fully populated (require loop) before any mount runs, so the
  // pos tender registry is readable here even though accounts mounts first.
  const tenderMethods = ctx.modules.pos.listTenders().map((t) => t.method);

  router.get('/api/accounts', MANAGERS, () => ({
    accounts: db.prepare('SELECT * FROM accounts ORDER BY code').all(),
  }));

  router.post('/api/accounts', ['admin'], (req) => {
    const a = accountPayload(db, req.body, null);
    const info = db
      .prepare('INSERT INTO accounts (code, name, kind, active) VALUES (?, ?, ?, ?)')
      .run(a.code, a.name, a.kind, a.active);
    audit(db, req.user.id, 'accounts.create', { code: a.code, kind: a.kind });
    return {
      account: db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(info.lastInsertRowid)),
    };
  });

  // Mapping table + everything the mapping UI needs to label its rows.
  router.get('/api/accounts/map', MANAGERS, () => ({
    mappings: db.prepare('SELECT * FROM account_map ORDER BY scope, ref_key').all(),
    targets: {
      products: db.prepare('SELECT id, sku, name, kind, active FROM products ORDER BY kind, name').all(),
      tax_groups: db.prepare('SELECT id, name, rate_bp FROM tax_groups ORDER BY id').all(),
      tenders: tenderMethods,
      discounts: db.prepare('SELECT id, code, name, active FROM discounts ORDER BY code').all(),
    },
  }));

  // Upsert one mapping; account_id null/'' removes it (activity falls to 9999).
  router.put('/api/accounts/map', ['admin'], (req) => {
    const scope = req.body?.scope;
    if (!SCOPES.includes(scope)) throw bad(`scope must be one of ${SCOPES.join(', ')}`);
    const refKey = validateRefKey(db, scope, req.body?.ref_key, tenderMethods);
    const rawId = req.body?.account_id;
    if (rawId === null || rawId === undefined || rawId === '') {
      db.prepare('DELETE FROM account_map WHERE scope = ? AND ref_key = ?').run(scope, refKey);
      audit(db, req.user.id, 'accounts.map.clear', { scope, ref_key: refKey });
      return { mapping: null };
    }
    const accountId = toInt(rawId, 'account_id', { min: 1 });
    if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
      throw bad(`no account with id ${rawId}`);
    }
    db.prepare(
      `INSERT INTO account_map (scope, ref_key, account_id) VALUES (?, ?, ?)
       ON CONFLICT(scope, ref_key) DO UPDATE SET account_id = excluded.account_id`
    ).run(scope, refKey, accountId);
    audit(db, req.user.id, 'accounts.map.set', { scope, ref_key: refKey, account_id: accountId });
    return {
      mapping: db.prepare('SELECT * FROM account_map WHERE scope = ? AND ref_key = ?').get(scope, refKey),
    };
  });

  router.get('/api/accounts/journal', MANAGERS, (req, res) =>
    respond(req, res, 'journal', journalReport(db, parseRange(req.query))));

  router.put('/api/accounts/:id', ['admin'], (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw bad('id must be a positive integer');
    const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!existing) throw new ApiError(404, 'not_found', 'No such account');
    const a = accountPayload(db, req.body, existing);
    db.prepare('UPDATE accounts SET code = ?, name = ?, kind = ?, active = ? WHERE id = ?')
      .run(a.code, a.name, a.kind, a.active, id);
    audit(db, req.user.id, 'accounts.update', { id, code: a.code });
    return { account: db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) };
  });
}

module.exports = { mount, ensureChart };
