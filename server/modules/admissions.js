'use strict';
// admissions — single validation entry point for ticket (T-…) and member (M-…) codes.
// Owns the admits table. Depends only on the db (never on other modules).
const { tx, now } = require('../core/db');
const { ApiError } = require('../core/http');

const SCAN_ROLES = ['gate', 'cashier', 'manager', 'admin'];
const ENTRY_GRACE_MS = 30 * 60_000; // session entry opens 30 min before start

// checkCode(db, code, gate) -> { result:'ok'|'denied', kind:'ticket'|'member'|'unknown',
//   reason:null|'unknown'|'void'|'expired'|'not_yet_valid'|'exhausted'|
//   'wrong_session_time'|'suspended', display_name, detail }
// ALWAYS inserts an admits row (ok or denied). Runs in a tx so an OK scan's
// uses_remaining decrement and the admits row commit together.
function checkCode(db, code, gate) {
  const cleaned = String(code || '').trim().toUpperCase();
  const gateName = String(gate || '').trim() || 'main';
  return tx(db, () => {
    const at = now();
    let out;
    const ticket = cleaned
      ? db.prepare(
          `SELECT t.*, p.name AS product_name
           FROM tickets t JOIN products p ON p.id = t.product_id
           WHERE t.code = ?`
        ).get(cleaned)
      : null;
    if (ticket) {
      out = checkTicket(db, ticket, at);
    } else {
      const member = cleaned
        ? db.prepare(
            `SELECT m.*, mp.name AS program_name
             FROM members m JOIN membership_programs mp ON mp.id = m.program_id
             WHERE m.pass_code = ?`
          ).get(cleaned)
        : null;
      if (member) {
        out = checkMember(member, at);
      } else {
        out = {
          result: 'denied', kind: 'unknown', reason: 'unknown',
          display_name: '', detail: 'No ticket or member matches this code',
          ticket_id: null, member_id: null,
        };
      }
    }
    db.prepare(
      `INSERT INTO admits (at, code, kind, ticket_id, member_id, gate, result, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(at, cleaned, out.kind, out.ticket_id, out.member_id, gateName, out.result, out.reason);
    return {
      result: out.result, kind: out.kind, reason: out.reason,
      display_name: out.display_name, detail: out.detail,
    };
  });
}

function checkTicket(db, t, at) {
  const base = {
    kind: 'ticket', ticket_id: t.id, member_id: null,
    display_name: t.holder_name || t.product_name,
  };
  const deny = (reason, detail) => ({ ...base, result: 'denied', reason, detail });
  if (t.status === 'void') {
    // same 'void' reason either way (reports bucket on it); the detail tells the
    // gate operator when the guest holds a replacement from an exchange
    const replacement = db
      .prepare('SELECT code FROM tickets WHERE exchanged_from = ?')
      .get(t.id);
    return deny(
      'void',
      replacement
        ? 'Ticket was exchanged — the guest holds a new ticket for another session'
        : 'Ticket has been voided'
    );
  }
  if (t.status === 'used' || t.uses_remaining <= 0) return deny('exhausted', 'No uses remaining');
  const nowMs = Date.parse(at);
  if (nowMs < Date.parse(t.valid_from)) {
    return deny('not_yet_valid', `Valid from ${t.valid_from}`);
  }
  if (nowMs > Date.parse(t.valid_to)) {
    return deny('expired', `Expired ${t.valid_to}`);
  }
  let detail = t.product_name;
  if (t.event_session_id != null) {
    const s = db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(t.event_session_id);
    if (s) {
      const openMs = Date.parse(s.starts_at) - ENTRY_GRACE_MS;
      const closeMs = Date.parse(s.ends_at);
      if (nowMs < openMs || nowMs > closeMs) {
        return deny(
          'wrong_session_time',
          `Session ${s.starts_at} — entry opens 30 min before start, closes at session end`
        );
      }
      detail += ` · session ${s.starts_at}`;
    }
  }
  const left = t.uses_remaining - 1;
  db.prepare(
    `UPDATE tickets SET uses_remaining = ?,
       status = CASE WHEN ? <= 0 THEN 'used' ELSE status END
     WHERE id = ?`
  ).run(left, left, t.id);
  return {
    ...base, result: 'ok', reason: null,
    detail: left > 0 ? `${detail} · ${left} use(s) left` : detail,
  };
}

function checkMember(m, at) {
  const base = { kind: 'member', ticket_id: null, member_id: m.id, display_name: m.name };
  if (m.status === 'suspended') {
    return {
      ...base, result: 'denied', reason: 'suspended',
      detail: `${m.program_name} membership is suspended`,
    };
  }
  if (Date.parse(m.expires_at) <= Date.parse(at)) {
    return {
      ...base, result: 'denied', reason: 'expired',
      detail: `${m.program_name} expired ${m.expires_at.slice(0, 10)} — renew at POS`,
    };
  }
  return {
    ...base, result: 'ok', reason: null,
    detail: `${m.program_name} · ${m.member_no} · expires ${m.expires_at.slice(0, 10)}`,
  };
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function mount(router, ctx) {
  const { db } = ctx;

  router.post('/api/admissions/scan', SCAN_ROLES, (req) => {
    const code = String(req.body?.code || '').trim();
    if (!code) throw new ApiError(400, 'bad_request', 'code is required');
    return checkCode(db, code, req.body?.gate);
  });

  // Today's OK-admit count + last 10 scans (feeds the gate UI side panel).
  router.get('/api/admissions/recent', SCAN_ROLES, () => {
    const dayStart = startOfTodayIso();
    const today_count = db
      .prepare("SELECT COUNT(*) AS n FROM admits WHERE result = 'ok' AND at >= ?")
      .get(dayStart).n;
    const recent = db.prepare(
      `SELECT a.id, a.at, a.code, a.kind, a.gate, a.result, a.reason,
              COALESCE(NULLIF(t.holder_name, ''), m.name, p.name, '') AS display_name
       FROM admits a
       LEFT JOIN tickets t ON t.id = a.ticket_id
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN members m ON m.id = a.member_id
       ORDER BY a.id DESC LIMIT 10`
    ).all();
    return { today_count, recent };
  });

  // Simulator data (manager+ only): currently-valid tickets and active members.
  router.get('/api/admissions/simulator', ['manager', 'admin'], () => {
    const at = now();
    const tickets = db.prepare(
      `SELECT t.id, t.code, t.uses_remaining, t.valid_to, t.holder_name,
              p.name AS product_name, s.starts_at AS session_starts_at
       FROM tickets t
       JOIN products p ON p.id = t.product_id
       LEFT JOIN event_sessions s ON s.id = t.event_session_id
       WHERE t.status = 'valid' AND t.uses_remaining > 0
         AND t.valid_from <= ? AND t.valid_to >= ?
       ORDER BY t.id DESC LIMIT 50`
    ).all(at, at);
    const members = db.prepare(
      `SELECT m.id, m.pass_code, m.name, m.member_no, m.expires_at, m.status,
              mp.name AS program_name
       FROM members m JOIN membership_programs mp ON mp.id = m.program_id
       WHERE m.status = 'active' AND m.expires_at > ?
       ORDER BY m.id DESC LIMIT 50`
    ).all(at);
    return { tickets, members };
  });
}

module.exports = { mount, checkCode };
