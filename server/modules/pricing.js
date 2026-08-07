'use strict';
// pricing — price programs: date-ranged, prioritized per-product price overrides.
//
// resolvePrice(db, productId, atIso) is the frozen cross-team contract (see
// openspec/changes/archive/2026-08-07-back-office-builders/design.md): pick the ACTIVE program whose
// starts_on..ends_on (SERVER-LOCAL calendar days, inclusive on both ends) covers the
// local day of atIso AND has an entry for the product. Highest priority wins; ties
// break to the lowest program id. Returns {price_cents, program_id, program_name}
// or null when no override applies. Phase-C wiring into the sellable feed and order
// posting is the coordinator's job — this module only owns programs + entries.
const { ApiError } = require('../core/http');
const { tx, now } = require('../core/db');
const { audit } = require('../core/auth');

const MANAGERS = ['admin', 'manager'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(message) {
  return new ApiError(400, 'bad_request', message);
}

function toInt(v, field, { min = null, max = null } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${field} must be an integer`);
  if (min !== null && n < min) throw bad(`${field} must be >= ${min}`);
  if (max !== null && n > max) throw bad(`${field} must be <= ${max}`);
  return n;
}

function toBit(v) {
  return v === 0 || v === false || v === '0' ? 0 : 1;
}

// Local calendar day (YYYY-MM-DD) of an ISO timestamp, in SERVER-LOCAL time —
// the same day semantics reports.js uses via date(ts, 'localtime').
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

// --- frozen contract export ------------------------------------------------------

function resolvePrice(db, productId, atIso) {
  const day = localDay(atIso);
  if (!day) return null;
  const row = db
    .prepare(
      `SELECT e.price_cents, p.id AS program_id, p.name AS program_name
       FROM price_program_entries e
       JOIN price_programs p ON p.id = e.program_id
       WHERE e.product_id = ? AND p.active = 1 AND p.starts_on <= ? AND p.ends_on >= ?
       ORDER BY p.priority DESC, p.id ASC
       LIMIT 1`
    )
    .get(productId, day, day);
  return row || null;
}

// --- validation / readers ---------------------------------------------------------

function programPayload(body, existing) {
  const src = { ...(existing || {}), ...(body || {}) };
  const name = String(src.name ?? '').trim();
  if (!name) throw bad('name is required');
  const starts_on = String(src.starts_on ?? '').trim();
  const ends_on = String(src.ends_on ?? '').trim();
  if (!DATE_RE.test(starts_on)) throw bad('starts_on must be YYYY-MM-DD');
  if (!DATE_RE.test(ends_on)) throw bad('ends_on must be YYYY-MM-DD');
  if (ends_on < starts_on) throw bad('ends_on is before starts_on');
  return {
    name,
    starts_on,
    ends_on,
    priority: toInt(src.priority ?? 0, 'priority', { min: -1000, max: 1000 }),
    active: toBit(src.active ?? 1),
  };
}

function programRow(db, id) {
  const today = localDay(now());
  return db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM price_program_entries e WHERE e.program_id = p.id)
                AS entry_count,
              (p.active = 1 AND p.starts_on <= ? AND p.ends_on >= ?) AS live
       FROM price_programs p WHERE p.id = ?`
    )
    .get(today, today, id);
}

function mustProgram(db, id) {
  const row = programRow(db, toInt(id, 'id', { min: 1 }));
  if (!row) throw new ApiError(404, 'not_found', 'No such price program');
  return row;
}

function entryRows(db, programId) {
  return db
    .prepare(
      `SELECT e.product_id, e.price_cents, pr.name AS product_name, pr.sku,
              pr.price_cents AS base_price_cents, pr.active AS product_active
       FROM price_program_entries e
       JOIN products pr ON pr.id = e.product_id
       WHERE e.program_id = ?
       ORDER BY pr.name`
    )
    .all(programId);
}

// Only overridden products are stored: the PUT replaces the program's entry set.
function entriesPayload(db, body) {
  const list = body?.entries;
  if (!Array.isArray(list)) throw bad('entries must be an array');
  const seen = new Set();
  return list.map((e) => {
    const product_id = toInt(e?.product_id, 'product_id', { min: 1 });
    if (seen.has(product_id)) throw bad(`duplicate entry for product ${product_id}`);
    seen.add(product_id);
    if (!db.prepare('SELECT id FROM products WHERE id = ?').get(product_id)) {
      throw bad(`product_id ${product_id} does not exist`);
    }
    return { product_id, price_cents: toInt(e?.price_cents, 'price_cents', { min: 0 }) };
  });
}

// --- mount -------------------------------------------------------------------------

function mount(router, ctx) {
  const db = ctx.db;

  // List (any signed-in user, per contract): programs + live-today flag.
  router.get('/api/pricing/programs', [], () => {
    const today = localDay(now());
    return {
      today,
      programs: db
        .prepare(
          `SELECT p.*,
                  (SELECT COUNT(*) FROM price_program_entries e WHERE e.program_id = p.id)
                    AS entry_count,
                  (p.active = 1 AND p.starts_on <= ? AND p.ends_on >= ?) AS live
           FROM price_programs p
           ORDER BY live DESC, p.priority DESC, p.starts_on, p.id`
        )
        .all(today, today),
    };
  });

  router.get('/api/pricing/programs/:id', MANAGERS, (req) => {
    const program = mustProgram(db, req.params.id);
    return { program, entries: entryRows(db, program.id) };
  });

  router.post('/api/pricing/programs', MANAGERS, (req) => {
    const p = programPayload(req.body, null);
    const info = db
      .prepare(
        `INSERT INTO price_programs (name, starts_on, ends_on, priority, active)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(p.name, p.starts_on, p.ends_on, p.priority, p.active);
    const id = Number(info.lastInsertRowid);
    audit(db, req.user.id, 'pricing.program.create', { id, name: p.name });
    return { program: programRow(db, id) };
  });

  router.put('/api/pricing/programs/:id', MANAGERS, (req) => {
    const existing = mustProgram(db, req.params.id);
    const p = programPayload(req.body, existing);
    db.prepare(
      `UPDATE price_programs SET name=?, starts_on=?, ends_on=?, priority=?, active=?
       WHERE id=?`
    ).run(p.name, p.starts_on, p.ends_on, p.priority, p.active, existing.id);
    audit(db, req.user.id, 'pricing.program.update', { id: existing.id, name: p.name });
    return { program: programRow(db, existing.id) };
  });

  // Programs are never referenced by orders (lines snapshot unit_price_cents),
  // so deleting one is safe and simply ends the override.
  router.del('/api/pricing/programs/:id', MANAGERS, (req) => {
    const existing = mustProgram(db, req.params.id);
    tx(db, () => {
      db.prepare('DELETE FROM price_program_entries WHERE program_id = ?').run(existing.id);
      db.prepare('DELETE FROM price_programs WHERE id = ?').run(existing.id);
    });
    audit(db, req.user.id, 'pricing.program.delete', { id: existing.id, name: existing.name });
    return { ok: true };
  });

  // Replace the program's override set atomically.
  router.put('/api/pricing/programs/:id/entries', MANAGERS, (req) => {
    const program = mustProgram(db, req.params.id);
    const entries = entriesPayload(db, req.body);
    tx(db, () => {
      db.prepare('DELETE FROM price_program_entries WHERE program_id = ?').run(program.id);
      const ins = db.prepare(
        'INSERT INTO price_program_entries (program_id, product_id, price_cents) VALUES (?, ?, ?)'
      );
      for (const e of entries) ins.run(program.id, e.product_id, e.price_cents);
    });
    audit(db, req.user.id, 'pricing.entries.replace', {
      program_id: program.id,
      count: entries.length,
    });
    return { program: programRow(db, program.id), entries: entryRows(db, program.id) };
  });
}

module.exports = { mount, resolvePrice };
