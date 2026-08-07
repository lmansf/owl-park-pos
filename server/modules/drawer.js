'use strict';
// drawer — per-cashier cash-drawer sessions: open float, paid-in/out movements,
// blind close with over/short, and per-session Z-reports reconciled against the
// payments table. pos.finalizeOrder/refundOrder stamp payments rows with the
// cashier's open session via openSessionFor (the cross-module seam); this module
// NEVER writes payments rows — pos owns that table.
//
// Blind-close discipline: no response readable by the session's opener may reveal
// the expected cash of a still-open drawer. That is why /api/drawer/current
// returns the float, the movement ledger, and a payment COUNT — never summed
// cash — and why paid-outs are capped only by the static MAX_CENTS (a
// balance-derived cap would be a binary-search oracle on the expected total).
const { ApiError, sendCSV } = require('../core/http');
const { tx, now } = require('../core/db');
const { audit } = require('../core/auth');

const SELL = ['cashier', 'manager', 'admin'];
const MANAGERS = ['manager', 'admin'];
const MAX_CENTS = 10_000_000; // $100k static cap on any single amount

function bad(code, message) {
  return new ApiError(400, code, message);
}

function checkCents(v, name, min) {
  // strict: a JSON number only — null/undefined/'' would coerce to 0 via Number()
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(n) || n < min || n > MAX_CENTS) {
    throw bad('bad_amount', `${name} must be an integer between ${min} and ${MAX_CENTS} cents`);
  }
  return n;
}

function idParam(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw bad('bad_id', 'id must be a positive integer');
  return id;
}

// Isolated so pluggable-tenders can widen payment methods without touching
// drawer math: only methods this predicate accepts count toward expected cash.
function isCashMethod(method) {
  return method === 'cash';
}

// The seam pos.finalizeOrder / refundOrder consume: the user's open session or null.
function openSessionFor(db, userId) {
  if (userId == null) return null;
  return (
    db.prepare("SELECT * FROM drawer_sessions WHERE status = 'open' AND opened_by = ?")
      .get(userId) || null
  );
}

function movementSums(db, sessionId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'paid_in' THEN amount_cents END), 0) AS paid_in,
              COALESCE(SUM(CASE WHEN kind = 'paid_out' THEN amount_cents END), 0) AS paid_out
       FROM drawer_movements WHERE drawer_session_id = ?`
    )
    .get(sessionId);
}

// Net cash through the drawer: sales net of change; refund rows are negative.
function cashNet(db, sessionId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents - change_cents), 0) AS n
       FROM payments WHERE drawer_session_id = ? AND method = 'cash'`
    )
    .get(sessionId).n;
}

function listMovements(db, sessionId) {
  return db
    .prepare(
      `SELECT m.id, m.kind, m.amount_cents, m.reason, m.created_at,
              u.display_name AS user
       FROM drawer_movements m JOIN users u ON u.id = m.user_id
       WHERE m.drawer_session_id = ? ORDER BY m.id`
    )
    .all(sessionId);
}

// Cashier-safe view of an OPEN session: float and ledger only, no expected/cash
// sums anywhere in the payload (blind-close invariant).
function openView(db, s) {
  return {
    session: {
      id: s.id,
      terminal: s.terminal,
      opened_by: s.opened_by,
      opened_at: s.opened_at,
      open_float_cents: s.open_float_cents,
      status: s.status,
    },
    movements: listMovements(db, s.id),
    payment_count: db
      .prepare('SELECT COUNT(*) AS n FROM payments WHERE drawer_session_id = ?')
      .get(s.id).n,
  };
}

// Blind close / force close: recompute expected from payments + movements INSIDE
// the tx (a concurrent finalize either committed first and is counted, or
// re-resolves after and finds no open drawer), allocate the next Z number,
// persist everything, audit, and return the Z report.
function closeSession(db, sessionId, userId, countedCents, note, opts = {}) {
  return tx(db, () => {
    const s = db.prepare('SELECT * FROM drawer_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new ApiError(404, 'not_found', `No drawer session ${sessionId}`);
    if (s.status !== 'open') {
      throw new ApiError(409, 'drawer_not_open', 'Drawer session is already closed');
    }
    const { paid_in, paid_out } = movementSums(db, s.id);
    const expected = s.open_float_cents + paid_in - paid_out + cashNet(db, s.id);
    const overShort = countedCents - expected;
    const z =
      1 + db.prepare('SELECT COALESCE(MAX(z_number), 0) AS n FROM drawer_sessions').get().n;
    db.prepare(
      `UPDATE drawer_sessions SET status = 'closed', closed_by = ?, closed_at = ?,
         counted_cents = ?, expected_cents = ?, over_short_cents = ?, close_note = ?,
         z_number = ? WHERE id = ?`
    ).run(userId, now(), countedCents, expected, overShort, note, z, s.id);
    audit(db, userId, 'drawer.close', {
      session_id: s.id, z_number: z, counted_cents: countedCents,
      expected_cents: expected, over_short_cents: overShort,
      ...(opts.forced ? { forced: true } : {}),
    });
    return zReport(db, s.id);
  });
}

// Z-report for a CLOSED session, in the uniform report sections shape so the
// reports CSV shaping (toCsvRows) renders it unchanged. The payments-by-method
// section is derived from the same payments rows salesReport sums — that
// equality IS the reconciliation contract.
function zReport(db, sessionId) {
  const s = db
    .prepare(
      `SELECT ds.*, u.display_name AS opened_by_name, c.display_name AS closed_by_name
       FROM drawer_sessions ds
       JOIN users u ON u.id = ds.opened_by
       LEFT JOIN users c ON c.id = ds.closed_by
       WHERE ds.id = ?`
    )
    .get(sessionId);
  if (!s) throw new ApiError(404, 'not_found', `No drawer session ${sessionId}`);
  if (s.status !== 'closed') {
    throw new ApiError(409, 'drawer_not_closed', 'Z-reports exist only for closed sessions');
  }
  const { paid_in, paid_out } = movementSums(db, s.id);
  const cashSplit = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents - change_cents END), 0) AS sales,
              COALESCE(SUM(CASE WHEN amount_cents < 0 THEN amount_cents END), 0) AS refunds
       FROM payments WHERE drawer_session_id = ? AND method = 'cash'`
    )
    .get(s.id);

  const reconRows = [
    { item: 'Opening float', amount_cents: s.open_float_cents },
    { item: 'Cash sales (net of change)', amount_cents: cashSplit.sales },
    { item: 'Cash refunds', amount_cents: cashSplit.refunds },
    { item: 'Paid in', amount_cents: paid_in },
    { item: 'Paid out', amount_cents: -paid_out },
    { item: 'Expected in drawer', amount_cents: s.expected_cents },
    { item: 'Counted', amount_cents: s.counted_cents },
    { item: 'Over/short', amount_cents: s.over_short_cents },
  ];

  const methodRows = db
    .prepare(
      `SELECT method, COUNT(*) AS payments,
              COALESCE(SUM(amount_cents - change_cents), 0) AS amount_cents
       FROM payments WHERE drawer_session_id = ? GROUP BY method ORDER BY method`
    )
    .all(s.id);
  const methodTotals = {
    method: 'TOTAL',
    payments: methodRows.reduce((a, r) => a + r.payments, 0),
    amount_cents: methodRows.reduce((a, r) => a + r.amount_cents, 0),
  };

  return {
    session: {
      id: s.id, terminal: s.terminal, status: s.status, z_number: s.z_number,
      opened_by: s.opened_by, opened_by_name: s.opened_by_name, opened_at: s.opened_at,
      closed_by: s.closed_by, closed_by_name: s.closed_by_name, closed_at: s.closed_at,
      open_float_cents: s.open_float_cents, counted_cents: s.counted_cents,
      expected_cents: s.expected_cents, over_short_cents: s.over_short_cents,
      close_note: s.close_note,
    },
    sections: [
      { title: 'Cash reconciliation', columns: ['item', 'amount_cents'], rows: reconRows },
      { title: 'Payments by method', columns: ['method', 'payments', 'amount_cents'],
        rows: methodRows, totals: methodTotals },
      { title: 'Movements', columns: ['created_at', 'kind', 'amount_cents', 'reason', 'user'],
        rows: listMovements(db, s.id) },
    ],
  };
}

function mount(router, ctx) {
  const db = ctx.db;

  // Open a drawer session with a counted float. One open session per user.
  router.post('/api/drawer/open', SELL, (req) => {
    const float = checkCents(req.body?.float_cents, 'float_cents', 0);
    const terminal = String(req.body?.terminal ?? 'main').trim().slice(0, 40) || 'main';
    return tx(db, () => {
      if (openSessionFor(db, req.user.id)) {
        throw new ApiError(409, 'drawer_already_open', 'You already have an open drawer session');
      }
      const info = db
        .prepare(
          `INSERT INTO drawer_sessions (terminal, opened_by, opened_at, open_float_cents, status)
           VALUES (?, ?, ?, ?, 'open')`
        )
        .run(terminal, req.user.id, now(), float);
      const s = db
        .prepare('SELECT * FROM drawer_sessions WHERE id = ?')
        .get(Number(info.lastInsertRowid));
      audit(db, req.user.id, 'drawer.open', {
        session_id: s.id, float_cents: float, terminal,
      });
      return openView(db, s);
    });
  });

  // The caller's own open session (never a client-supplied id). Blind: no cash sums.
  router.get('/api/drawer/current', SELL, (req) => {
    const s = openSessionFor(db, req.user.id);
    return s ? openView(db, s) : { session: null };
  });

  // Paid-in / paid-out against the caller's own open session. Immutable ledger:
  // there is deliberately no update or delete route.
  router.post('/api/drawer/movements', SELL, (req) => {
    const kind = req.body?.kind;
    if (kind !== 'paid_in' && kind !== 'paid_out') {
      throw bad('bad_kind', 'kind must be paid_in or paid_out');
    }
    const amount = checkCents(req.body?.amount_cents, 'amount_cents', 1);
    const reason = String(req.body?.reason || '').trim();
    if (!reason || reason.length > 200) {
      throw bad('bad_reason', 'reason is required (1-200 characters)');
    }
    return tx(db, () => {
      const s = openSessionFor(db, req.user.id);
      if (!s) throw new ApiError(409, 'drawer_not_open', 'Open a drawer session first');
      const info = db
        .prepare(
          `INSERT INTO drawer_movements (drawer_session_id, kind, amount_cents, reason,
             user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(s.id, kind, amount, reason, req.user.id, now());
      audit(db, req.user.id, 'drawer.movement', {
        session_id: s.id, kind, amount_cents: amount, reason,
      });
      return {
        movement: db
          .prepare('SELECT * FROM drawer_movements WHERE id = ?')
          .get(Number(info.lastInsertRowid)),
      };
    });
  });

  // Blind close of the caller's own open session: counted cash in, Z report out.
  router.post('/api/drawer/close', SELL, (req) => {
    const counted = checkCents(req.body?.counted_cents, 'counted_cents', 0);
    const note = String(req.body?.note || '').trim();
    if (note.length > 500) throw bad('bad_note', 'note must be at most 500 characters');
    return tx(db, () => {
      const s = openSessionFor(db, req.user.id);
      if (!s) throw new ApiError(409, 'drawer_not_open', 'You have no open drawer session');
      return closeSession(db, s.id, req.user.id, counted, note);
    });
  });

  // Manager force-close of any open session (abandoned drawer). The manager
  // counts the till, so this is not blind for them; audit marks it forced.
  router.post('/api/drawer/sessions/:id/close', MANAGERS, (req) => {
    const id = idParam(req.params.id);
    const counted = checkCents(req.body?.counted_cents, 'counted_cents', 0);
    const note = String(req.body?.note || '').trim();
    if (note.length > 500) throw bad('bad_note', 'note must be at most 500 characters');
    return closeSession(db, id, req.user.id, counted, note, { forced: true });
  });

  // Manager list, date-ranged like the reports (local days, inclusive): sessions
  // opened in range or still open. Expected/over-short are the persisted values —
  // present for closed sessions, null while open (they are computed only at close).
  router.get('/api/drawer/sessions', MANAGERS, (req) => {
    const rng = ctx.modules.reports.parseRange(req.query);
    const sessions = db
      .prepare(
        `SELECT ds.id, ds.terminal, ds.status, ds.z_number, ds.opened_at, ds.closed_at,
                ds.open_float_cents, ds.counted_cents, ds.expected_cents,
                ds.over_short_cents, ds.close_note,
                u.display_name AS opened_by_name, c.display_name AS closed_by_name
         FROM drawer_sessions ds
         JOIN users u ON u.id = ds.opened_by
         LEFT JOIN users c ON c.id = ds.closed_by
         WHERE (ds.opened_at >= ? AND ds.opened_at < ?) OR ds.status = 'open'
         ORDER BY ds.opened_at DESC`
      )
      .all(rng.fromIso, rng.toIso);
    return { range: { from: rng.from, to: rng.to }, sessions };
  });

  // Z-report: managers, or the session's own opener. A cashier probing another
  // user's id gets the same 404 as a nonexistent id (no existence oracle).
  router.get('/api/drawer/sessions/:id/z', SELL, (req, res) => {
    const id = idParam(req.params.id);
    const s = db.prepare('SELECT id, opened_by FROM drawer_sessions WHERE id = ?').get(id);
    const isManager = MANAGERS.includes(req.user.role);
    if (!s || (!isManager && s.opened_by !== req.user.id)) {
      throw new ApiError(404, 'not_found', `No drawer session ${id}`);
    }
    const z = zReport(db, id);
    if (req.query.format === 'csv') {
      sendCSV(res, `z-report-${z.session.z_number}.csv`, ctx.modules.reports.toCsvRows(z));
      return undefined;
    }
    return z;
  });
}

module.exports = { mount, openSessionFor, closeSession, zReport, isCashMethod };
