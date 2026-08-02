'use strict';
const { ApiError } = require('../core/http');
const { audit } = require('../core/auth');

const KINDS = ['ticket', 'membership', 'addon'];
const CHANNELS = ['pos', 'web'];

// --- pure exports (consumed by pos/store at request time) ---------------------

// Active products sellable on the given channel, with resolved tax rate.
function getSellable(db, channel) {
  const rows = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.kind, p.price_cents, t.rate_bp AS tax_rate_bp,
              p.event_id, p.membership_program_id, p.validity_days, p.max_uses, p.channels
       FROM products p JOIN tax_groups t ON t.id = p.tax_group_id
       WHERE p.active = 1
       ORDER BY p.kind, p.name`
    )
    .all();
  return rows
    .filter((r) => String(r.channels).split(',').map((s) => s.trim()).includes(channel))
    .map(({ channels, ...rest }) => rest);
}

// Returns the active discounts row for a code (case-insensitive), or null.
function validateDiscount(db, code) {
  if (!code) return null;
  const row = db
    .prepare('SELECT * FROM discounts WHERE code = ? COLLATE NOCASE AND active = 1')
    .get(String(code).trim());
  return row || null;
}

// --- validation helpers --------------------------------------------------------

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

function normalizeChannels(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  const set = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  if (!set.length) throw bad('channels must include at least one of pos, web');
  for (const ch of set) {
    if (!CHANNELS.includes(ch)) throw bad(`unknown channel "${ch}"`);
  }
  return CHANNELS.filter((c) => set.includes(c)).join(',');
}

function requireRef(db, table, id, field) {
  if (id === null || id === undefined || id === '') return null;
  const n = toInt(id, field, { min: 1 });
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(n);
  if (!row) throw bad(`${field} ${n} does not exist`);
  return n;
}

// Merge request body over an existing row (or defaults) and validate everything.
function productPayload(db, body, existing) {
  const src = { ...(existing || {}), ...(body || {}) };
  const sku = String(src.sku ?? '').trim().toUpperCase();
  if (!sku) throw bad('sku is required');
  const name = String(src.name ?? '').trim();
  if (!name) throw bad('name is required');
  if (!KINDS.includes(src.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  const out = {
    sku,
    name,
    kind: src.kind,
    price_cents: toInt(src.price_cents, 'price_cents', { min: 0 }),
    tax_group_id: requireRef(db, 'tax_groups', src.tax_group_id, 'tax_group_id'),
    event_id: requireRef(db, 'events', src.event_id, 'event_id'),
    membership_program_id: requireRef(
      db, 'membership_programs', src.membership_program_id, 'membership_program_id'
    ),
    validity_days: toInt(src.validity_days ?? 1, 'validity_days', { min: 1 }),
    max_uses: toInt(src.max_uses ?? 1, 'max_uses', { min: 1 }),
    channels: normalizeChannels(src.channels ?? 'pos,web'),
    active: toBit(src.active ?? 1),
  };
  if (out.tax_group_id === null) throw bad('tax_group_id is required');
  if (out.kind === 'membership' && !out.membership_program_id) {
    throw bad('membership products need a membership_program_id');
  }
  const dupe = db.prepare('SELECT id FROM products WHERE sku = ?').get(out.sku);
  if (dupe && (!existing || dupe.id !== existing.id)) {
    throw new ApiError(409, 'sku_taken', `SKU "${out.sku}" already exists`);
  }
  return out;
}

function discountPayload(db, body, existing) {
  const src = { ...(existing || {}), ...(body || {}) };
  const code = String(src.code ?? '').trim().toUpperCase();
  if (!code) throw bad('code is required');
  const name = String(src.name ?? '').trim();
  if (!name) throw bad('name is required');
  if (!['percent', 'amount'].includes(src.kind)) throw bad('kind must be percent or amount');
  const value =
    src.kind === 'percent'
      ? toInt(src.value, 'value', { min: 1, max: 100 })
      : toInt(src.value, 'value', { min: 1 });
  const dupe = db.prepare('SELECT id FROM discounts WHERE code = ? COLLATE NOCASE').get(code);
  if (dupe && (!existing || dupe.id !== existing.id)) {
    throw new ApiError(409, 'code_taken', `Discount code "${code}" already exists`);
  }
  return { code, name, kind: src.kind, value, active: toBit(src.active ?? 1) };
}

// --- row readers ----------------------------------------------------------------

function productRow(db, id) {
  return db
    .prepare(
      `SELECT p.*, t.name AS tax_group_name, t.rate_bp AS tax_rate_bp,
              EXISTS(SELECT 1 FROM order_lines ol WHERE ol.product_id = p.id) AS has_sales
       FROM products p JOIN tax_groups t ON t.id = p.tax_group_id
       WHERE p.id = ?`
    )
    .get(id);
}

function mustProduct(db, id) {
  const row = productRow(db, toInt(id, 'id', { min: 1 }));
  if (!row) throw new ApiError(404, 'not_found', 'No such product');
  return row;
}

// --- mount ------------------------------------------------------------------------

function mount(router, ctx) {
  const db = ctx.db;

  // Sell-surface feed: single source of truth for POS and store rendering.
  router.get('/api/catalog/sellable', [], (req) => {
    const channel = req.query.channel;
    if (!CHANNELS.includes(channel)) throw bad('channel must be pos or web');
    return { products: getSellable(db, channel) };
  });

  // Reference lists for the catalog editor dropdowns (read-only).
  router.get('/api/catalog/meta', ['admin', 'manager'], () => ({
    tax_groups: db.prepare('SELECT * FROM tax_groups ORDER BY id').all(),
    events: db.prepare('SELECT id, name, active FROM events ORDER BY name').all(),
    membership_programs: db
      .prepare('SELECT id, name, duration_days FROM membership_programs ORDER BY name')
      .all(),
  }));

  // Products — CRU only; sold products live forever, so there is no DELETE route.
  router.get('/api/catalog/products', ['admin', 'manager'], () => ({
    products: db
      .prepare(
        `SELECT p.*, t.name AS tax_group_name, t.rate_bp AS tax_rate_bp,
                EXISTS(SELECT 1 FROM order_lines ol WHERE ol.product_id = p.id) AS has_sales
         FROM products p JOIN tax_groups t ON t.id = p.tax_group_id
         ORDER BY p.kind, p.name`
      )
      .all(),
  }));

  router.post('/api/catalog/products', ['admin', 'manager'], (req) => {
    const p = productPayload(db, req.body, null);
    const info = db
      .prepare(
        `INSERT INTO products (sku, name, kind, price_cents, tax_group_id, event_id,
           membership_program_id, validity_days, max_uses, channels, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        p.sku, p.name, p.kind, p.price_cents, p.tax_group_id, p.event_id,
        p.membership_program_id, p.validity_days, p.max_uses, p.channels, p.active
      );
    audit(db, req.user.id, 'catalog.product.create', { sku: p.sku });
    return { product: productRow(db, Number(info.lastInsertRowid)) };
  });

  router.put('/api/catalog/products/:id', ['admin', 'manager'], (req) => {
    const existing = mustProduct(db, req.params.id);
    const p = productPayload(db, req.body, existing);
    db.prepare(
      `UPDATE products SET sku=?, name=?, kind=?, price_cents=?, tax_group_id=?, event_id=?,
         membership_program_id=?, validity_days=?, max_uses=?, channels=?, active=?
       WHERE id=?`
    ).run(
      p.sku, p.name, p.kind, p.price_cents, p.tax_group_id, p.event_id,
      p.membership_program_id, p.validity_days, p.max_uses, p.channels, p.active,
      existing.id
    );
    audit(db, req.user.id, 'catalog.product.update', { id: existing.id, sku: p.sku });
    return { product: productRow(db, existing.id) };
  });

  // Tax groups — rates are admin-only per spec; managers may read.
  router.get('/api/catalog/tax-groups', ['admin', 'manager'], () => ({
    tax_groups: db.prepare('SELECT * FROM tax_groups ORDER BY id').all(),
  }));

  router.post('/api/catalog/tax-groups', ['admin'], (req) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw bad('name is required');
    const rate_bp = toInt(req.body?.rate_bp, 'rate_bp', { min: 0, max: 10000 });
    const info = db.prepare('INSERT INTO tax_groups (name, rate_bp) VALUES (?, ?)').run(name, rate_bp);
    audit(db, req.user.id, 'catalog.tax_group.create', { name, rate_bp });
    return {
      tax_group: db.prepare('SELECT * FROM tax_groups WHERE id = ?').get(Number(info.lastInsertRowid)),
    };
  });

  router.put('/api/catalog/tax-groups/:id', ['admin'], (req) => {
    const id = toInt(req.params.id, 'id', { min: 1 });
    const existing = db.prepare('SELECT * FROM tax_groups WHERE id = ?').get(id);
    if (!existing) throw new ApiError(404, 'not_found', 'No such tax group');
    const name = String(req.body?.name ?? existing.name).trim();
    if (!name) throw bad('name is required');
    const rate_bp = toInt(req.body?.rate_bp ?? existing.rate_bp, 'rate_bp', { min: 0, max: 10000 });
    db.prepare('UPDATE tax_groups SET name = ?, rate_bp = ? WHERE id = ?').run(name, rate_bp, id);
    audit(db, req.user.id, 'catalog.tax_group.update', { id, name, rate_bp });
    return { tax_group: db.prepare('SELECT * FROM tax_groups WHERE id = ?').get(id) };
  });

  // Discounts
  router.get('/api/catalog/discounts', ['admin', 'manager'], () => ({
    discounts: db.prepare('SELECT * FROM discounts ORDER BY code').all(),
  }));

  router.post('/api/catalog/discounts', ['admin', 'manager'], (req) => {
    const d = discountPayload(db, req.body, null);
    const info = db
      .prepare('INSERT INTO discounts (code, name, kind, value, active) VALUES (?, ?, ?, ?, ?)')
      .run(d.code, d.name, d.kind, d.value, d.active);
    audit(db, req.user.id, 'catalog.discount.create', { code: d.code });
    return {
      discount: db.prepare('SELECT * FROM discounts WHERE id = ?').get(Number(info.lastInsertRowid)),
    };
  });

  router.put('/api/catalog/discounts/:id', ['admin', 'manager'], (req) => {
    const id = toInt(req.params.id, 'id', { min: 1 });
    const existing = db.prepare('SELECT * FROM discounts WHERE id = ?').get(id);
    if (!existing) throw new ApiError(404, 'not_found', 'No such discount');
    const d = discountPayload(db, req.body, existing);
    db.prepare('UPDATE discounts SET code=?, name=?, kind=?, value=?, active=? WHERE id=?')
      .run(d.code, d.name, d.kind, d.value, d.active, id);
    audit(db, req.user.id, 'catalog.discount.update', { id, code: d.code });
    return { discount: db.prepare('SELECT * FROM discounts WHERE id = ?').get(id) };
  });

  router.post('/api/catalog/discounts/validate', [], (req) => {
    const discount = validateDiscount(db, req.body?.code);
    if (!discount) throw new ApiError(404, 'bad_discount', 'Invalid or inactive discount code');
    return { discount };
  });
}

module.exports = { mount, getSellable, validateDiscount };
