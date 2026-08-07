'use strict';
// events module — timed sessions + THE capacity gate (reserveCapacity/releaseCapacity).
const { ApiError, toInt } = require('../core/http');
const { tx, now } = require('../core/db');
const { audit } = require('../core/auth');

// ---------- exported capacity primitives ----------

function getSession(db, id) {
  return db.prepare('SELECT * FROM event_sessions WHERE id = ?').get(id) || null;
}

// MUST be called inside an outer tx (core/db tx). Re-checks sold + qty <= capacity and
// cancelled = 0 atomically via a guarded UPDATE; throws ApiError(409,'capacity') otherwise.
function reserveCapacity(db, sessionId, qty) {
  const n = Number(qty);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, 'bad_qty', 'qty must be a positive integer');
  }
  const r = db
    .prepare(
      `UPDATE event_sessions SET sold = sold + ?
       WHERE id = ? AND cancelled = 0 AND sold + ? <= capacity`
    )
    .run(n, sessionId, n);
  if (r.changes !== 1) {
    const s = getSession(db, sessionId);
    if (!s) throw new ApiError(409, 'capacity', `No such session ${sessionId}`);
    if (s.cancelled) throw new ApiError(409, 'capacity', 'Session is cancelled');
    throw new ApiError(
      409, 'capacity',
      `Not enough seats: ${s.capacity - s.sold} remaining, ${n} requested`
    );
  }
}

// Inverse of reserveCapacity (refunds/voids). Clamps at 0.
function releaseCapacity(db, sessionId, qty) {
  const n = Number(qty);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError(400, 'bad_qty', 'qty must be a positive integer');
  }
  db.prepare('UPDATE event_sessions SET sold = MAX(0, sold - ?) WHERE id = ?')
    .run(n, sessionId);
}

// ---------- helpers ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

function localDate(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function sessionView(s) {
  return {
    id: s.id,
    event_id: s.event_id,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    capacity: s.capacity,
    sold: s.sold,
    remaining: s.capacity - s.sold,
    sold_out: s.capacity - s.sold <= 0,
  };
}

// ---------- mount ----------

function mount(router, ctx) {
  const db = ctx.db;

  // List events (any signed-in user; POS session picker uses this too).
  router.get('/api/events', [], () => {
    const events = db
      .prepare(
        `SELECT e.id, e.name, e.description, e.active,
                (SELECT COUNT(*) FROM event_sessions s
                 WHERE s.event_id = e.id AND s.cancelled = 0) AS session_count
         FROM events e ORDER BY e.name`
      )
      .all();
    return { events };
  });

  router.post('/api/events', ['admin', 'manager'], (req) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw new ApiError(400, 'bad_name', 'Event name is required');
    const description = String(req.body.description || '').trim();
    const r = db
      .prepare('INSERT INTO events (name, description, active) VALUES (?, ?, 1)')
      .run(name, description);
    audit(db, req.user.id, 'events.create', { event_id: Number(r.lastInsertRowid), name });
    return { event: db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid) };
  });

  router.put('/api/events/:id', ['admin', 'manager'], (req) => {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!ev) throw new ApiError(404, 'no_event', 'Event not found');
    const name = req.body.name !== undefined ? String(req.body.name).trim() : ev.name;
    if (!name) throw new ApiError(400, 'bad_name', 'Event name cannot be empty');
    const description =
      req.body.description !== undefined ? String(req.body.description).trim() : ev.description;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : ev.active;
    db.prepare('UPDATE events SET name = ?, description = ?, active = ? WHERE id = ?')
      .run(name, description, active, ev.id);
    audit(db, req.user.id, 'events.update', { event_id: ev.id });
    return { event: db.prepare('SELECT * FROM events WHERE id = ?').get(ev.id) };
  });

  // Availability API — PUBLIC: the online store links straight to it.
  // Excludes cancelled sessions; remaining = capacity - sold; sold_out when remaining <= 0.
  router.get('/api/events/:id/sessions', null, (req) => {
    const ev = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
    if (!ev) throw new ApiError(404, 'no_event', 'Event not found');
    let sql = 'SELECT * FROM event_sessions WHERE event_id = ? AND cancelled = 0';
    const args = [ev.id];
    let { from, to } = req.query;
    if (from) {
      from = String(from);
      // date-only "from" = start of that LOCAL day (sessions are generated in local time)
      if (DATE_RE.test(from)) from = localDate(from, '00:00').toISOString();
      sql += ' AND starts_at >= ?';
      args.push(from);
    }
    if (to) {
      to = String(to);
      if (DATE_RE.test(to)) {
        // date-only "to" = end of that LOCAL day
        const next = localDate(to, '00:00');
        next.setDate(next.getDate() + 1);
        to = new Date(next.getTime() - 1).toISOString();
      }
      sql += ' AND starts_at <= ?';
      args.push(to);
    }
    sql += ' ORDER BY starts_at';
    return { sessions: db.prepare(sql).all(...args).map(sessionView) };
  });

  // Bulk generation: date range + first/last start time + interval + capacity.
  router.post('/api/events/:id/sessions/generate', ['admin', 'manager'], (req) => {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!ev) throw new ApiError(404, 'no_event', 'Event not found');
    const b = req.body || {};
    const startDate = String(b.start_date || '');
    const endDate = String(b.end_date || '');
    const startTime = String(b.start_time || '');
    const endTime = String(b.end_time || '');
    const interval = toInt(b.interval_minutes, 'interval_minutes', { min: 1 });
    const capacity = toInt(b.capacity, 'capacity', { min: 1 });
    const duration = b.duration_minutes === undefined || b.duration_minutes === '' || b.duration_minutes === null
      ? interval
      : toInt(b.duration_minutes, 'duration_minutes', { min: 1 });

    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      throw new ApiError(400, 'bad_dates', 'start_date and end_date must be YYYY-MM-DD');
    }
    if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
      throw new ApiError(400, 'bad_times', 'start_time and end_time must be HH:MM');
    }

    const day0 = localDate(startDate, '00:00');
    const dayN = localDate(endDate, '00:00');
    if (dayN < day0) throw new ApiError(400, 'bad_range', 'end_date is before start_date');
    const days = Math.round((dayN - day0) / (24 * 3600 * 1000)) + 1;
    if (days > 366) throw new ApiError(400, 'range_too_large', 'Date range exceeds one year');
    if (localDate(startDate, endTime) < localDate(startDate, startTime)) {
      throw new ApiError(400, 'bad_range', 'end_time is before start_time');
    }
    const slotsPerDay =
      Math.floor((localDate(startDate, endTime) - localDate(startDate, startTime)) / (interval * 60_000)) + 1;
    if (days * slotsPerDay > 10_000) {
      throw new ApiError(400, 'range_too_large', 'Would generate more than 10,000 sessions');
    }

    const exists = db.prepare(
      'SELECT 1 FROM event_sessions WHERE event_id = ? AND starts_at = ? AND cancelled = 0'
    );
    const ins = db.prepare(
      'INSERT INTO event_sessions (event_id, starts_at, ends_at, capacity) VALUES (?, ?, ?, ?)'
    );
    let created = 0;
    let skipped = 0;
    tx(db, () => {
      for (let d = 0; d < days; d++) {
        const base = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + d);
        const dateStr = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
        const last = localDate(dateStr, endTime);
        for (let t = localDate(dateStr, startTime); t <= last; t = new Date(t.getTime() + interval * 60_000)) {
          const startsAt = t.toISOString();
          if (exists.get(ev.id, startsAt)) {
            skipped++;
            continue;
          }
          ins.run(ev.id, startsAt, new Date(t.getTime() + duration * 60_000).toISOString(), capacity);
          created++;
        }
      }
      audit(db, req.user.id, 'events.generate_sessions', {
        event_id: ev.id, start_date: startDate, end_date: endDate, created, skipped,
      });
    });
    return { created, skipped };
  });

  // Edit capacity — never below sold.
  router.put('/api/events/sessions/:id', ['admin', 'manager'], (req) => {
    const capacity = toInt(req.body.capacity, 'capacity', { min: 1 });
    return tx(db, () => {
      const s = getSession(db, req.params.id);
      if (!s) throw new ApiError(404, 'no_session', 'Session not found');
      if (s.cancelled) throw new ApiError(409, 'cancelled', 'Session is cancelled');
      if (capacity < s.sold) {
        throw new ApiError(
          409, 'capacity_below_sold',
          `Cannot set capacity to ${capacity}: ${s.sold} already sold`
        );
      }
      db.prepare('UPDATE event_sessions SET capacity = ? WHERE id = ?').run(capacity, s.id);
      audit(db, req.user.id, 'events.session_capacity', {
        session_id: s.id, from: s.capacity, to: capacity,
      });
      return { session: sessionView(getSession(db, s.id)) };
    });
  });

  // Cancel a session (manager). If it has sold tickets, voiding them requires the POS
  // module to be loaded (it owns ticket lifecycle); otherwise reject with a clear error.
  router.post('/api/events/sessions/:id/cancel', ['admin', 'manager'], (req) => {
    return tx(db, () => {
      const s = getSession(db, req.params.id);
      if (!s) throw new ApiError(404, 'no_session', 'Session not found');
      if (s.cancelled) throw new ApiError(409, 'already_cancelled', 'Session is already cancelled');
      const soldSomething =
        s.sold > 0 ||
        db.prepare(
          "SELECT COUNT(*) AS n FROM tickets WHERE event_session_id = ? AND status = 'valid'"
        ).get(s.id).n > 0;
      if (soldSomething && !ctx.modules.pos) {
        throw new ApiError(
          409, 'pos_required',
          'Session has sold tickets and the POS module is not loaded to void them'
        );
      }
      const voided = db
        .prepare("UPDATE tickets SET status = 'void' WHERE event_session_id = ? AND status = 'valid'")
        .run(s.id).changes;
      db.prepare('UPDATE event_sessions SET cancelled = 1 WHERE id = ?').run(s.id);
      audit(db, req.user.id, 'events.session_cancel', {
        session_id: s.id, event_id: s.event_id, starts_at: s.starts_at, voided_tickets: voided, at: now(),
      });
      return { ok: true, voided_tickets: voided };
    });
  });
}

module.exports = { mount, reserveCapacity, releaseCapacity, getSession };
