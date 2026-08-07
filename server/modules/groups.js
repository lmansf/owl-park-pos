'use strict';
const { ApiError, toInt } = require('../core/http');
const { tx } = require('../core/db');
const { audit } = require('../core/auth');

// --- pure exports (consumed by menu-builder / webstore-builder / item-config) ---

// Groups with membership counts. Default: active only; {all:true} includes inactive
// (used by the editor via ?all=1).
function listGroups(db, { all = false } = {}) {
  return db
    .prepare(
      `SELECT g.id, g.name, g.sort, g.color, g.active,
              (SELECT COUNT(*) FROM product_groups pg WHERE pg.group_id = g.id) AS product_count
       FROM item_groups g
       ${all ? '' : 'WHERE g.active = 1'}
       ORDER BY g.sort, g.name, g.id`
    )
    .all();
}

// Product ids assigned to a group. Inactive or missing groups yield [] so
// menu/store references to a deactivated group degrade to an empty section.
function productIdsInGroup(db, groupId) {
  const g = db.prepare('SELECT id FROM item_groups WHERE id = ? AND active = 1').get(groupId);
  if (!g) return [];
  return db
    .prepare('SELECT product_id FROM product_groups WHERE group_id = ? ORDER BY product_id')
    .all(groupId)
    .map((r) => r.product_id);
}

// Active groups a product belongs to.
function groupsForProduct(db, productId) {
  return db
    .prepare(
      `SELECT g.id, g.name, g.sort, g.color, g.active
       FROM item_groups g JOIN product_groups pg ON pg.group_id = g.id
       WHERE pg.product_id = ? AND g.active = 1
       ORDER BY g.sort, g.name, g.id`
    )
    .all(productId);
}

// --- validation helpers ---------------------------------------------------------

function bad(message) {
  return new ApiError(400, 'bad_request', message);
}

function toBit(v) {
  return v === 0 || v === false || v === '0' ? 0 : 1;
}

function groupPayload(body, existing) {
  const src = { ...(existing || {}), ...(body || {}) };
  const name = String(src.name ?? '').trim();
  if (!name) throw bad('name is required');
  return {
    name,
    sort: toInt(src.sort ?? 0, 'sort'),
    color: String(src.color ?? '').trim(),
    active: toBit(src.active ?? 1),
  };
}

function groupRow(db, id) {
  return db
    .prepare(
      `SELECT g.id, g.name, g.sort, g.color, g.active,
              (SELECT COUNT(*) FROM product_groups pg WHERE pg.group_id = g.id) AS product_count
       FROM item_groups g WHERE g.id = ?`
    )
    .get(id);
}

function mustGroup(db, id) {
  const row = groupRow(db, toInt(id, 'id', { min: 1 }));
  if (!row) throw new ApiError(404, 'not_found', 'No such group');
  return row;
}

// --- mount ------------------------------------------------------------------------

function mount(router, ctx) {
  const db = ctx.db;

  // Read API for consumers: any signed-in role. ?all=1 includes inactive (editor).
  router.get('/api/groups', [], (req) => ({
    groups: listGroups(db, { all: req.query.all === '1' }),
  }));

  // Single group with membership, for the editor picker.
  router.get('/api/groups/:id', [], (req) => {
    const group = mustGroup(db, req.params.id);
    return {
      group,
      product_ids: db
        .prepare('SELECT product_id FROM product_groups WHERE group_id = ? ORDER BY product_id')
        .all(group.id)
        .map((r) => r.product_id),
    };
  });

  router.post('/api/groups', ['admin', 'manager'], (req) => {
    const g = groupPayload(req.body, null);
    const info = db
      .prepare('INSERT INTO item_groups (name, sort, color, active) VALUES (?, ?, ?, ?)')
      .run(g.name, g.sort, g.color, g.active);
    const id = Number(info.lastInsertRowid);
    audit(db, req.user.id, 'groups.create', { id, name: g.name });
    return { group: groupRow(db, id) };
  });

  router.put('/api/groups/:id', ['admin', 'manager'], (req) => {
    const existing = mustGroup(db, req.params.id);
    const g = groupPayload(req.body, existing);
    db.prepare('UPDATE item_groups SET name=?, sort=?, color=?, active=? WHERE id=?')
      .run(g.name, g.sort, g.color, g.active, existing.id);
    audit(db, req.user.id, 'groups.update', { id: existing.id, name: g.name, active: g.active });
    return { group: groupRow(db, existing.id) };
  });

  // Delete = deactivate; groups referenced by menus/store sections must never dangle.
  router.del('/api/groups/:id', ['admin', 'manager'], (req) => {
    const existing = mustGroup(db, req.params.id);
    db.prepare('UPDATE item_groups SET active = 0 WHERE id = ?').run(existing.id);
    audit(db, req.user.id, 'groups.deactivate', { id: existing.id, name: existing.name });
    return { group: groupRow(db, existing.id) };
  });

  // Replace group membership atomically.
  router.put('/api/groups/:id/products', ['admin', 'manager'], (req) => {
    const existing = mustGroup(db, req.params.id);
    const raw = req.body?.product_ids;
    if (!Array.isArray(raw)) throw bad('product_ids must be an array');
    const ids = [...new Set(raw.map((v) => toInt(v, 'product_ids[]', { min: 1 })))];
    const known = db.prepare('SELECT id FROM products WHERE id = ?');
    for (const pid of ids) {
      if (!known.get(pid)) throw bad(`product ${pid} does not exist`);
    }
    tx(db, () => {
      db.prepare('DELETE FROM product_groups WHERE group_id = ?').run(existing.id);
      const ins = db.prepare('INSERT INTO product_groups (product_id, group_id) VALUES (?, ?)');
      for (const pid of ids) ins.run(pid, existing.id);
    });
    audit(db, req.user.id, 'groups.assign', { group_id: existing.id, product_ids: ids });
    return { group: groupRow(db, existing.id), product_ids: ids.sort((a, b) => a - b) };
  });
}

module.exports = { mount, listGroups, productIdsInGroup, groupsForProduct };
