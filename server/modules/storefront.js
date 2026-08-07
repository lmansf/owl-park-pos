'use strict';
// storefront — guest store landing-layout builder + the anonymous layout feed.
// The builder (admin/manager) edits hero settings (core settings table, store_* keys)
// and ordered store_sections rows. The public GET /api/store/layout resolves sections
// into guest-safe product cards server-side: only web-channel active products via
// ctx.modules.catalog.getSellable(db,'web'), group membership via
// ctx.modules.groups.productIdsInGroup — both presence-guarded so the module degrades
// to an empty layout when siblings are absent (isolated tests, partial installs).
const { ApiError } = require('../core/http');
const { audit } = require('../core/auth');

const KINDS = ['products', 'groups', 'html'];
const SETTING_KEYS = { hero_title: 'store_hero_title', hero_sub: 'store_hero_sub', accent: 'store_accent' };
const MAX_HTML = 100_000;

function bad(message) {
  return new ApiError(400, 'bad_request', message);
}

function toInt(v, field, { min = null } = {}) {
  // Strict: only real numbers or non-empty numeric strings. Number() alone
  // coerces null->0, true->1, [7]->7 — all of those must 400, not pass.
  const n =
    typeof v === 'number' ? v
      : typeof v === 'string' && v.trim() !== '' ? Number(v)
        : NaN;
  if (!Number.isInteger(n)) throw bad(`${field} must be an integer`);
  if (min !== null && n < min) throw bad(`${field} must be >= ${min}`);
  return n;
}

function toBit(v) {
  return v === 0 || v === false || v === '0' ? 0 : 1;
}

// --- html sanitiser ---------------------------------------------------------------
//
// html sections render UNESCAPED into the guest store page, which is served from
// the same origin as the back office — so a section body must never be able to
// script (a manager-authored <img onerror=…> would run with any staff viewer's
// session). Sanitised on write AND on read (getLayout), so rows stored before
// this guard existed are cleaned too. Allowlist re-serialisation: only known
// content tags survive, attributes are rebuilt from an allowlist with entity-
// decoded, scheme-checked URLs, everything else (comments, unknown tags, stray
// '<') is dropped or escaped. No script/style/iframe/svg/math/form, ever.

const SAFE_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);
const SAFE_ATTRS = new Set([
  'alt', 'class', 'colspan', 'height', 'href', 'id', 'rowspan', 'src', 'style',
  'title', 'width',
]);
const URL_ATTRS = new Set(['href', 'src']);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Decode entities so a scheme can't hide behind &#106;avascript: — checks run
// on the decoded value and the output is re-escaped from that decoded form.
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Allow relative URLs and http/https/mailto/tel plus inline data images.
// Browsers strip control chars/whitespace inside URLs, so the scheme probe does too.
function safeUrl(decoded) {
  const probe = decoded.replace(/[\u0000-\u0020]/g, '');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (!m) return true; // relative / fragment / query
  const scheme = m[1].toLowerCase();
  if (['http', 'https', 'mailto', 'tel'].includes(scheme)) return true;
  return scheme === 'data' && /^data:image\/(?:png|gif|jpe?g|webp);/i.test(probe);
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][\w-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`<>=]+))?)*)\s*\/?>/y;
const ATTR_RE = /([a-zA-Z][\w-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`<>=]+))?/g;

function sanitizeAttrs(raw) {
  let out = '';
  ATTR_RE.lastIndex = 0;
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!SAFE_ATTRS.has(name) || name.startsWith('on')) continue;
    if (m[2] === undefined) { out += ` ${name}`; continue; }
    const quoted = /^["']/.test(m[2]) ? m[2].slice(1, -1) : m[2];
    const value = decodeEntities(quoted);
    if (URL_ATTRS.has(name) && !safeUrl(value)) continue;
    if (name === 'style' && /expression\s*\(|javascript:/i.test(value)) continue;
    out += ` ${name}="${escapeHtml(value)}"`;
  }
  return out;
}

function sanitizeHtml(html) {
  const src = String(html);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { out += src.slice(i); break; }
    out += src.slice(i, lt);
    if (src.startsWith('<!--', lt)) {          // comment: drop whole thing
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') { // doctype/PI: drop to '>'
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(src);
    if (!m) { out += '&lt;'; i = lt + 1; continue; } // stray '<': escape it
    i = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!SAFE_TAGS.has(tag)) continue;         // unknown/dangerous tag: dropped
    out += closing ? `</${tag}>` : `<${tag}${sanitizeAttrs(m[3])}>`;
  }
  return out;
}

// --- settings -------------------------------------------------------------------

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function storeSettings(db) {
  const out = {};
  for (const [name, key] of Object.entries(SETTING_KEYS)) out[name] = getSetting(db, key);
  return out;
}

// --- section validation -----------------------------------------------------------

// Validate a section payload (body merged over existing) and normalize its config
// to exactly the fields its kind needs — nothing else is ever stored or echoed.
function sectionPayload(body, existing) {
  const src = { ...(existing || {}), ...(body || {}) };
  const title = String(src.title ?? '').trim();
  if (!title) throw bad('title is required');
  if (!KINDS.includes(src.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);

  // If the kind changed, stale config from the old kind must not linger.
  const cfgSrc =
    body && body.config !== undefined
      ? body.config
      : existing && existing.kind === src.kind
        ? existing.config
        : {};
  const cfg = typeof cfgSrc === 'string' ? safeParse(cfgSrc) : cfgSrc || {};

  let config;
  if (src.kind === 'products') {
    const ids = cfg.product_ids;
    if (!Array.isArray(ids) || !ids.length) {
      throw bad('a products section needs config.product_ids (non-empty array)');
    }
    const seen = new Set();
    const clean = [];
    for (const id of ids) {
      const n = toInt(id, 'product_ids entry', { min: 1 });
      if (!seen.has(n)) { seen.add(n); clean.push(n); }
    }
    config = { product_ids: clean };
  } else if (src.kind === 'groups') {
    config = { group_id: toInt(cfg.group_id, 'config.group_id', { min: 1 }) };
  } else {
    const html = String(cfg.html ?? '');
    if (html.length > MAX_HTML) throw bad(`config.html is limited to ${MAX_HTML} characters`);
    config = { html: sanitizeHtml(html) };
  }

  return {
    title,
    kind: src.kind,
    sort: toInt(src.sort ?? 0, 'sort'),
    active: toBit(src.active ?? 1),
    config: JSON.stringify(config),
  };
}

function safeParse(json) {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function sectionRow(db, id) {
  const row = db.prepare('SELECT * FROM store_sections WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, config: safeParse(row.config) };
}

function mustSection(db, id) {
  const row = sectionRow(db, toInt(id, 'id', { min: 1 }));
  if (!row) throw new ApiError(404, 'not_found', 'No such section');
  return row;
}

// --- public layout ------------------------------------------------------------------

// Resolve the landing layout for guests. Products come exclusively from the shared
// web sellable feed, so pos-only/inactive products can never leak, no matter what
// ids were hand-picked into a section.
function getLayout(db, ctx) {
  const sellable =
    ctx.modules?.catalog?.getSellable ? ctx.modules.catalog.getSellable(db, 'web') : [];
  const byId = new Map(sellable.map((p) => [p.id, p]));

  const rows = db
    .prepare('SELECT * FROM store_sections WHERE active = 1 ORDER BY sort, id')
    .all();

  const sections = [];
  for (const row of rows) {
    const cfg = safeParse(row.config);
    const base = { id: row.id, title: row.title, kind: row.kind, sort: row.sort };
    if (row.kind === 'products') {
      const ids = Array.isArray(cfg.product_ids) ? cfg.product_ids : [];
      sections.push({ ...base, products: ids.map((id) => byId.get(id)).filter(Boolean) });
    } else if (row.kind === 'groups') {
      const ids = ctx.modules?.groups?.productIdsInGroup
        ? ctx.modules.groups.productIdsInGroup(db, cfg.group_id)
        : [];
      sections.push({ ...base, products: (ids || []).map((id) => byId.get(id)).filter(Boolean) });
    } else if (row.kind === 'html') {
      // re-sanitised on the way out too: covers rows stored before the guard
      sections.push({ ...base, html: sanitizeHtml(String(cfg.html ?? '')) });
    }
    // any other kind (legacy 'hero' rows) is not part of the guest layout
  }

  return { settings: storeSettings(db), sections };
}

// --- mount ---------------------------------------------------------------------------

function mount(router, ctx) {
  const db = ctx.db;

  // Anonymous: everything the store landing page needs, resolved server-side.
  router.get('/api/store/layout', null, () => getLayout(db, ctx));

  // Builder: hero settings ------------------------------------------------------------
  router.get('/api/storefront/settings', ['admin', 'manager'], () => ({
    settings: storeSettings(db),
  }));

  router.put('/api/storefront/settings', ['admin', 'manager'], (req) => {
    const b = req.body || {};
    const next = {};
    for (const name of Object.keys(SETTING_KEYS)) {
      if (b[name] === undefined) continue;
      next[name] = String(b[name] ?? '').trim();
    }
    if ('accent' in next && next.accent && !/^#([0-9a-fA-F]{3,4}|(?:[0-9a-fA-F]{2}){3,4})$/.test(next.accent)) {
      throw bad('accent must be a hex color like #3b4ed8 (or empty for the default)');
    }
    for (const [name, value] of Object.entries(next)) setSetting(db, SETTING_KEYS[name], value);
    audit(db, req.user.id, 'storefront.settings.update', next);
    return { settings: storeSettings(db) };
  });

  // Builder: sections -------------------------------------------------------------------
  router.get('/api/storefront/sections', ['admin', 'manager'], () => ({
    sections: db
      .prepare('SELECT * FROM store_sections ORDER BY sort, id')
      .all()
      .map((r) => ({ ...r, config: safeParse(r.config) })),
  }));

  router.post('/api/storefront/sections', ['admin', 'manager'], (req) => {
    const s = sectionPayload(req.body, null);
    const info = db
      .prepare('INSERT INTO store_sections (title, kind, sort, active, config) VALUES (?, ?, ?, ?, ?)')
      .run(s.title, s.kind, s.sort, s.active, s.config);
    const id = Number(info.lastInsertRowid);
    audit(db, req.user.id, 'storefront.section.create', { id, title: s.title, kind: s.kind });
    return { section: sectionRow(db, id) };
  });

  router.put('/api/storefront/sections/:id', ['admin', 'manager'], (req) => {
    const existing = mustSection(db, req.params.id);
    const s = sectionPayload(req.body, existing);
    db.prepare('UPDATE store_sections SET title=?, kind=?, sort=?, active=?, config=? WHERE id=?')
      .run(s.title, s.kind, s.sort, s.active, s.config, existing.id);
    audit(db, req.user.id, 'storefront.section.update', { id: existing.id, title: s.title });
    return { section: sectionRow(db, existing.id) };
  });

  router.del('/api/storefront/sections/:id', ['admin', 'manager'], (req) => {
    const existing = mustSection(db, req.params.id);
    db.prepare('DELETE FROM store_sections WHERE id = ?').run(existing.id);
    audit(db, req.user.id, 'storefront.section.delete', { id: existing.id, title: existing.title });
    return { ok: true };
  });
}

module.exports = { mount, getLayout, sanitizeHtml };
