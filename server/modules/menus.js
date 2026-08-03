'use strict';
const { ApiError } = require('../core/http');
const { tx } = require('../core/db');
const { audit } = require('../core/auth');

const SIZES = ['sm', 'md', 'lg'];
const ROLES = ['admin', 'manager'];

// --- pure exports (consumed by POS rendering at request time) -------------------

// Active menu: active pages with their active buttons in position order.
// Product buttons carry a product join; buttons for inactive products and
// link buttons whose target page is missing/inactive are omitted.
function getActiveMenu(db) {
  const pages = db
    .prepare('SELECT id, name, sort FROM menu_pages WHERE active = 1 ORDER BY sort, id')
    .all()
    .map((p) => ({ ...p, buttons: [] }));
  const activeIds = new Set(pages.map((p) => p.id));
  const byPage = new Map(pages.map((p) => [p.id, p]));
  const rows = db
    .prepare(
      `SELECT b.id, b.page_id, b.position, b.label, b.color, b.size,
              b.product_id, b.link_page_id,
              p.name AS p_name, p.price_cents AS p_price_cents, p.kind AS p_kind,
              p.event_id AS p_event_id, p.active AS p_active
       FROM menu_buttons b LEFT JOIN products p ON p.id = b.product_id
       WHERE b.active = 1
       ORDER BY b.position, b.id`
    )
    .all();
  for (const r of rows) {
    const page = byPage.get(r.page_id);
    if (!page) continue; // page inactive
    if (r.product_id != null && !r.p_active) continue; // inactive product
    if (r.link_page_id != null && !activeIds.has(r.link_page_id)) continue; // dead link
    page.buttons.push({
      id: r.id,
      position: r.position,
      label: r.label,
      color: r.color,
      size: r.size,
      product_id: r.product_id,
      link_page_id: r.link_page_id,
      product:
        r.product_id != null
          ? { name: r.p_name, price_cents: r.p_price_cents, kind: r.p_kind, event_id: r.p_event_id }
          : null,
    });
  }
  return { pages };
}

// --- validation helpers ----------------------------------------------------------

function bad(message) {
  return new ApiError(400, 'bad_request', message);
}

function toInt(v, field, { min = null } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${field} must be an integer`);
  if (min !== null && n < min) throw bad(`${field} must be >= ${min}`);
  return n;
}

function toBit(v) {
  return v === 0 || v === false || v === '0' ? 0 : 1;
}

function isEmpty(v) {
  return v === null || v === undefined || v === '';
}

function pagePayload(body, existing) {
  const src = { ...(existing || {}), ...(body || {}) };
  const name = String(src.name ?? '').trim();
  if (!name) throw bad('name is required');
  return {
    name,
    sort: toInt(src.sort ?? 0, 'sort'),
    active: toBit(src.active ?? 1),
  };
}

function mustPage(db, id) {
  const page = db.prepare('SELECT * FROM menu_pages WHERE id = ?').get(toInt(id, 'id', { min: 1 }));
  if (!page) throw new ApiError(404, 'not_found', 'No such menu page');
  return page;
}

function mustButton(db, id) {
  const btn = db
    .prepare('SELECT * FROM menu_buttons WHERE id = ?')
    .get(toInt(id, 'id', { min: 1 }));
  if (!btn) throw new ApiError(404, 'not_found', 'No such menu button');
  return btn;
}

function nextPosition(db, pageId) {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), 0) AS max FROM menu_buttons WHERE page_id = ?')
    .get(pageId);
  return row.max + 1;
}

function assertPositionFree(db, pageId, position, exceptButtonId) {
  const taken = db
    .prepare('SELECT id FROM menu_buttons WHERE page_id = ? AND position = ?')
    .get(pageId, position);
  if (taken && taken.id !== exceptButtonId) {
    throw new ApiError(409, 'position_taken', `Position ${position} is already taken on this page`);
  }
}

// Merge body over an existing button (or defaults) and validate the XOR rule.
// To switch a button's type on edit, the client sends the other ref as null.
function buttonPayload(db, body, existing, pageId) {
  const src = { ...(existing || {}), ...(body || {}) };
  const size = src.size ?? 'md';
  if (!SIZES.includes(size)) throw bad(`size must be one of ${SIZES.join(', ')}`);
  const productId = isEmpty(src.product_id) ? null : toInt(src.product_id, 'product_id', { min: 1 });
  const linkPageId = isEmpty(src.link_page_id) ? null : toInt(src.link_page_id, 'link_page_id', { min: 1 });
  if ((productId === null) === (linkPageId === null)) {
    throw bad('a button is either a product button (product_id) or a page link (link_page_id) — set exactly one');
  }
  if (productId !== null && !db.prepare('SELECT id FROM products WHERE id = ?').get(productId)) {
    throw bad(`product_id ${productId} does not exist`);
  }
  if (linkPageId !== null) {
    if (linkPageId === pageId) throw bad('a page cannot link to itself');
    if (!db.prepare('SELECT id FROM menu_pages WHERE id = ?').get(linkPageId)) {
      throw bad(`link_page_id ${linkPageId} does not exist`);
    }
  }
  const position = isEmpty(src.position)
    ? nextPosition(db, pageId)
    : toInt(src.position, 'position', { min: 1 });
  return {
    position,
    label: String(src.label ?? '').trim(),
    color: String(src.color ?? '').trim(),
    size,
    product_id: productId,
    link_page_id: linkPageId,
    active: toBit(src.active ?? 1),
  };
}

// --- builder readers ---------------------------------------------------------------

function builderButton(db, id) {
  return db
    .prepare(
      `SELECT b.*, p.name AS product_name, p.price_cents AS product_price_cents,
              p.active AS product_active,
              lp.name AS link_page_name, lp.active AS link_page_active
       FROM menu_buttons b
       LEFT JOIN products p ON p.id = b.product_id
       LEFT JOIN menu_pages lp ON lp.id = b.link_page_id
       WHERE b.id = ?`
    )
    .get(id);
}

function builderPages(db) {
  const pages = db
    .prepare('SELECT * FROM menu_pages ORDER BY sort, id')
    .all()
    .map((p) => ({ ...p, buttons: [] }));
  const byPage = new Map(pages.map((p) => [p.id, p]));
  const buttons = db
    .prepare(
      `SELECT b.*, p.name AS product_name, p.price_cents AS product_price_cents,
              p.active AS product_active,
              lp.name AS link_page_name, lp.active AS link_page_active
       FROM menu_buttons b
       LEFT JOIN products p ON p.id = b.product_id
       LEFT JOIN menu_pages lp ON lp.id = b.link_page_id
       ORDER BY b.position, b.id`
    )
    .all();
  for (const b of buttons) byPage.get(b.page_id)?.buttons.push(b);
  return pages;
}

// --- mount ---------------------------------------------------------------------------

function mount(router, ctx) {
  const db = ctx.db;

  // POS feed: what the terminal renders. Any signed-in role.
  router.get('/api/menus/active', [], () => getActiveMenu(db));

  // Builder view: every page and button, including inactive ones.
  router.get('/api/menus/pages', ROLES, () => ({ pages: builderPages(db) }));

  router.post('/api/menus/pages', ROLES, (req) => {
    const p = pagePayload(req.body, null);
    const info = db
      .prepare('INSERT INTO menu_pages (name, sort, active) VALUES (?, ?, ?)')
      .run(p.name, p.sort, p.active);
    const id = Number(info.lastInsertRowid);
    audit(db, req.user.id, 'menus.page.create', { id, name: p.name });
    return { page: db.prepare('SELECT * FROM menu_pages WHERE id = ?').get(id) };
  });

  router.put('/api/menus/pages/:id', ROLES, (req) => {
    const existing = mustPage(db, req.params.id);
    const p = pagePayload(req.body, existing);
    db.prepare('UPDATE menu_pages SET name = ?, sort = ?, active = ? WHERE id = ?')
      .run(p.name, p.sort, p.active, existing.id);
    audit(db, req.user.id, 'menus.page.update', { id: existing.id, name: p.name });
    return { page: db.prepare('SELECT * FROM menu_pages WHERE id = ?').get(existing.id) };
  });

  // Deleting a page removes its buttons AND any link buttons targeting it
  // (referential safety — confirmation happens in the builder UI).
  router.del('/api/menus/pages/:id', ROLES, (req) => {
    const page = mustPage(db, req.params.id);
    let removed = 0;
    tx(db, () => {
      removed = db
        .prepare('DELETE FROM menu_buttons WHERE page_id = ? OR link_page_id = ?')
        .run(page.id, page.id).changes;
      db.prepare('DELETE FROM menu_pages WHERE id = ?').run(page.id);
    });
    audit(db, req.user.id, 'menus.page.delete', { id: page.id, name: page.name, removed_buttons: removed });
    return { ok: true, removed_buttons: removed };
  });

  router.post('/api/menus/pages/:id/buttons', ROLES, (req) => {
    const page = mustPage(db, req.params.id);
    const b = buttonPayload(db, req.body, null, page.id);
    assertPositionFree(db, page.id, b.position, null);
    const info = db
      .prepare(
        `INSERT INTO menu_buttons (page_id, position, label, color, size, product_id, link_page_id, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(page.id, b.position, b.label, b.color, b.size, b.product_id, b.link_page_id, b.active);
    const id = Number(info.lastInsertRowid);
    audit(db, req.user.id, 'menus.button.create', { id, page_id: page.id });
    return { button: builderButton(db, id) };
  });

  router.put('/api/menus/buttons/:id', ROLES, (req) => {
    const existing = mustButton(db, req.params.id);
    const b = buttonPayload(db, req.body, existing, existing.page_id);
    assertPositionFree(db, existing.page_id, b.position, existing.id);
    db.prepare(
      `UPDATE menu_buttons SET position=?, label=?, color=?, size=?, product_id=?, link_page_id=?, active=?
       WHERE id=?`
    ).run(b.position, b.label, b.color, b.size, b.product_id, b.link_page_id, b.active, existing.id);
    audit(db, req.user.id, 'menus.button.update', { id: existing.id });
    return { button: builderButton(db, existing.id) };
  });

  router.del('/api/menus/buttons/:id', ROLES, (req) => {
    const existing = mustButton(db, req.params.id);
    db.prepare('DELETE FROM menu_buttons WHERE id = ?').run(existing.id);
    audit(db, req.user.id, 'menus.button.delete', { id: existing.id, page_id: existing.page_id });
    return { ok: true };
  });

  // Move = position swap: if another button on the page holds the target
  // position, the two trade places; otherwise the button just moves there.
  router.post('/api/menus/buttons/:id/move', ROLES, (req) => {
    const btn = mustButton(db, req.params.id);
    const position = toInt(req.body?.position, 'position', { min: 1 });
    tx(db, () => {
      const other = db
        .prepare('SELECT id FROM menu_buttons WHERE page_id = ? AND position = ? AND id != ?')
        .get(btn.page_id, position, btn.id);
      if (other) {
        db.prepare('UPDATE menu_buttons SET position = ? WHERE id = ?').run(btn.position, other.id);
      }
      db.prepare('UPDATE menu_buttons SET position = ? WHERE id = ?').run(position, btn.id);
    });
    audit(db, req.user.id, 'menus.button.move', { id: btn.id, from: btn.position, to: position });
    return { buttons: builderPages(db).find((p) => p.id === btn.page_id)?.buttons ?? [] };
  });

  // Fill a page with product buttons — from an item group (when the groups
  // module is present) or from the POS sellable feed as the fallback source.
  router.post('/api/menus/pages/:id/generate', ROLES, (req) => {
    const page = mustPage(db, req.params.id);
    let productIds;
    if (!isEmpty(req.body?.group_id)) {
      const groups = ctx.modules.groups;
      if (!groups || typeof groups.productIdsInGroup !== 'function') {
        throw new ApiError(400, 'groups_unavailable', 'The item-groups module is not available');
      }
      productIds = groups.productIdsInGroup(db, toInt(req.body.group_id, 'group_id', { min: 1 }));
    } else if (req.body?.source === 'catalog') {
      const catalog = ctx.modules.catalog;
      if (!catalog || typeof catalog.getSellable !== 'function') {
        throw new ApiError(400, 'catalog_unavailable', 'The catalog module is not available');
      }
      productIds = catalog.getSellable(db, 'pos').map((p) => p.id);
    } else {
      throw bad('provide group_id or source: "catalog"');
    }
    let added = 0;
    tx(db, () => {
      const present = new Set(
        db.prepare('SELECT product_id FROM menu_buttons WHERE page_id = ? AND product_id IS NOT NULL')
          .all(page.id)
          .map((r) => r.product_id)
      );
      let pos = nextPosition(db, page.id);
      const exists = db.prepare('SELECT id FROM products WHERE id = ?');
      const insert = db.prepare(
        `INSERT INTO menu_buttons (page_id, position, label, color, size, product_id, link_page_id, active)
         VALUES (?, ?, '', '', 'md', ?, NULL, 1)`
      );
      for (const pid of productIds) {
        if (present.has(pid) || !exists.get(pid)) continue;
        insert.run(page.id, pos++, pid);
        present.add(pid);
        added++;
      }
    });
    audit(db, req.user.id, 'menus.page.generate', { id: page.id, added });
    return { added, page: builderPages(db).find((p) => p.id === page.id) };
  });
}

module.exports = { mount, getActiveMenu };
