'use strict';
const { ApiError } = require('../core/http');
const { tx, now } = require('../core/db');
const { audit, randomCode } = require('../core/auth');

const STAFF = ['admin', 'manager', 'cashier'];
const MANAGERS = ['admin', 'manager'];

function uniqueCode(db, column, gen) {
  for (let i = 0; i < 25; i++) {
    const code = gen();
    if (!db.prepare(`SELECT 1 FROM members WHERE ${column} = ?`).get(code)) return code;
  }
  throw new Error(`could not allocate unique ${column}`);
}

// Create a new member, or renew an existing one, for a membership sale.
// member_id given => renew that member; else an active member matching
// email+program_id is renewed; else a fresh member is created.
// Renewal: expires_at = max(now, current expiry) + program.duration_days.
function createOrRenewMember(db, { program_id, name, email, member_id }) {
  return tx(db, () => {
    const program = db
      .prepare('SELECT * FROM membership_programs WHERE id = ?')
      .get(program_id);
    if (!program) throw new ApiError(400, 'bad_program', `No membership program ${program_id}`);

    let member = null;
    if (member_id) {
      member = db.prepare('SELECT * FROM members WHERE id = ?').get(member_id);
      if (!member) throw new ApiError(404, 'member_not_found', `No member ${member_id}`);
    } else if (email) {
      member = db
        .prepare(
          `SELECT * FROM members
           WHERE status = 'active' AND lower(email) = lower(?) AND program_id = ?
           ORDER BY id LIMIT 1`
        )
        .get(String(email), program_id) || null;
    }

    const nowIso = now();
    if (member) {
      const currentExpiry = Date.parse(member.expires_at) || 0;
      const base = Math.max(Date.parse(nowIso), currentExpiry);
      const expiresAt = new Date(base + program.duration_days * (24 * 3600 * 1000)).toISOString();
      db.prepare(
        `UPDATE members SET program_id = ?, expires_at = ?,
           name = CASE WHEN name = '' THEN ? ELSE name END,
           email = CASE WHEN email = '' THEN ? ELSE email END
         WHERE id = ?`
      ).run(program.id, expiresAt, String(name || ''), String(email || ''), member.id);
      return db.prepare('SELECT * FROM members WHERE id = ?').get(member.id);
    }

    const memberNo = uniqueCode(db, 'member_no', () => 'GM-' + randomCode('', 6));
    const passCode = uniqueCode(db, 'pass_code', () => randomCode('M-', 10));
    const expiresAt = new Date(Date.parse(nowIso) + program.duration_days * (24 * 3600 * 1000)).toISOString();
    const info = db
      .prepare(
        `INSERT INTO members (member_no, name, email, program_id, pass_code, joined_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(memberNo, String(name || ''), String(email || ''), program.id, passCode, nowIso, expiresAt);
    return db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
  });
}

function memberDetail(db, id) {
  return db
    .prepare(
      `SELECT m.*, p.name AS program_name, p.duration_days, p.benefits
       FROM members m JOIN membership_programs p ON p.id = m.program_id
       WHERE m.id = ?`
    )
    .get(id);
}

function validateProgramInput(body) {
  const name = String(body?.name || '').trim();
  const duration = Number(body?.duration_days);
  if (!name) throw new ApiError(400, 'bad_program', 'Program name is required');
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new ApiError(400, 'bad_program', 'duration_days must be a positive integer');
  }
  return { name, duration_days: duration, benefits: String(body?.benefits || '') };
}

function mount(router, ctx) {
  const db = ctx.db;

  router.get('/api/membership/settings', [], () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'venue_name'").get();
    return { venue_name: row?.value || 'Owl Park' };
  });

  // ---- programs ----------------------------------------------------------

  router.get('/api/membership/programs', [], () => {
    const programs = db
      .prepare(
        `SELECT pr.*,
           (SELECT p.price_cents FROM products p
             WHERE p.membership_program_id = pr.id AND p.active = 1
             ORDER BY p.id LIMIT 1) AS price_cents,
           (SELECT p.name FROM products p
             WHERE p.membership_program_id = pr.id AND p.active = 1
             ORDER BY p.id LIMIT 1) AS product_name,
           (SELECT COUNT(*) FROM members m WHERE m.program_id = pr.id) AS member_count
         FROM membership_programs pr ORDER BY pr.id`
      )
      .all();
    return { programs };
  });

  router.post('/api/membership/programs', MANAGERS, (req) => {
    const p = validateProgramInput(req.body);
    const info = db
      .prepare('INSERT INTO membership_programs (name, duration_days, benefits) VALUES (?, ?, ?)')
      .run(p.name, p.duration_days, p.benefits);
    audit(db, req.user.id, 'membership.program.create', { id: info.lastInsertRowid, name: p.name });
    return {
      program: db.prepare('SELECT * FROM membership_programs WHERE id = ?').get(info.lastInsertRowid),
    };
  });

  router.put('/api/membership/programs/:id', MANAGERS, (req) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM membership_programs WHERE id = ?').get(id);
    if (!existing) throw new ApiError(404, 'not_found', `No program ${id}`);
    const p = validateProgramInput(req.body);
    db.prepare('UPDATE membership_programs SET name = ?, duration_days = ?, benefits = ? WHERE id = ?')
      .run(p.name, p.duration_days, p.benefits, id);
    audit(db, req.user.id, 'membership.program.update', { id, name: p.name });
    return { program: db.prepare('SELECT * FROM membership_programs WHERE id = ?').get(id) };
  });

  router.del('/api/membership/programs/:id', MANAGERS, (req) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM membership_programs WHERE id = ?').get(id);
    if (!existing) throw new ApiError(404, 'not_found', `No program ${id}`);
    const inUse =
      db.prepare('SELECT 1 FROM members WHERE program_id = ? LIMIT 1').get(id) ||
      db.prepare('SELECT 1 FROM products WHERE membership_program_id = ? LIMIT 1').get(id);
    if (inUse) {
      throw new ApiError(409, 'program_in_use', 'Program has members or a linked product; cannot delete');
    }
    db.prepare('DELETE FROM membership_programs WHERE id = ?').run(id);
    audit(db, req.user.id, 'membership.program.delete', { id, name: existing.name });
    return { ok: true };
  });

  // ---- members -----------------------------------------------------------

  router.get('/api/membership/members', STAFF, (req) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const members = db
      .prepare(
        `SELECT m.*, p.name AS program_name
         FROM members m JOIN membership_programs p ON p.id = m.program_id
         WHERE ? = '' OR m.name LIKE ? OR m.email LIKE ? OR m.member_no LIKE ? OR m.pass_code LIKE ?
         ORDER BY m.name, m.id LIMIT 100`
      )
      .all(q, like, like, like, like);
    return { members };
  });

  router.get('/api/membership/members/:id', STAFF, (req) => {
    const member = memberDetail(db, Number(req.params.id));
    if (!member) throw new ApiError(404, 'not_found', `No member ${req.params.id}`);
    return { member };
  });

  router.put('/api/membership/members/:id', STAFF, (req) => {
    const id = Number(req.params.id);
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!member) throw new ApiError(404, 'not_found', `No member ${id}`);
    const name = String(req.body?.name ?? member.name).trim();
    const email = String(req.body?.email ?? member.email).trim();
    if (!name) throw new ApiError(400, 'bad_member', 'Member name is required');
    db.prepare('UPDATE members SET name = ?, email = ? WHERE id = ?').run(name, email, id);
    audit(db, req.user.id, 'membership.member.update', { id, name, email });
    return { member: memberDetail(db, id) };
  });

  router.post('/api/membership/members/:id/suspend', MANAGERS, (req) => {
    const id = Number(req.params.id);
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!member) throw new ApiError(404, 'not_found', `No member ${id}`);
    db.prepare("UPDATE members SET status = 'suspended' WHERE id = ?").run(id);
    audit(db, req.user.id, 'membership.member.suspend', { id, member_no: member.member_no });
    return { member: memberDetail(db, id) };
  });

  router.post('/api/membership/members/:id/reinstate', MANAGERS, (req) => {
    const id = Number(req.params.id);
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!member) throw new ApiError(404, 'not_found', `No member ${id}`);
    db.prepare("UPDATE members SET status = 'active' WHERE id = ?").run(id);
    audit(db, req.user.id, 'membership.member.reinstate', { id, member_no: member.member_no });
    return { member: memberDetail(db, id) };
  });
}

module.exports = { mount, createOrRenewMember };
