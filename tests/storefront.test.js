'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer() {
  const app = createApp(tempDb());
  const { server, db, ctx } = app;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, ctx, base };
}

// minimal cookie-carrying client
function client(base) {
  let cookie = '';
  return async (method, apiPath, body) => {
    const res = await fetch(base + apiPath, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    return { status: res.status, data };
  };
}

test('storefront: builder + anonymous layout feed', async (t) => {
  const { server, db, ctx, base } = await startServer();
  t.after(() => server.close());

  const guest = client(base); // never signs in
  const manager = client(base);
  const cashier = client(base);
  await manager('POST', '/api/auth/login', { username: 'manager', password: 'manager' });
  await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });

  let webProducts; // seeded web sellable feed, for reference
  let memberships;

  await t.test('fallback: empty install → empty sections, blank settings', async () => {
    const r = await guest('GET', '/api/store/layout');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.sections, []);
    assert.deepEqual(r.data.settings, { hero_title: '', hero_sub: '', accent: '' });
  });

  await t.test('builder routes are admin/manager only', async () => {
    const anon = await guest('GET', '/api/storefront/sections');
    assert.equal(anon.status, 401);
    const cash = await cashier('GET', '/api/storefront/sections');
    assert.equal(cash.status, 403);
    const cashPut = await cashier('PUT', '/api/storefront/settings', { hero_title: 'nope' });
    assert.equal(cashPut.status, 403);
    const mgr = await manager('GET', '/api/storefront/sections');
    assert.equal(mgr.status, 200);
    assert.deepEqual(mgr.data.sections, []);
  });

  await t.test('hero settings persist under store_* keys and validate accent', async () => {
    const bad = await manager('PUT', '/api/storefront/settings', { accent: 'red' });
    assert.equal(bad.status, 400);

    const r = await manager('PUT', '/api/storefront/settings', {
      hero_title: 'Welcome to Owl Park',
      hero_sub: 'Open every day',
      accent: '#22aa66',
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.hero_title, 'Welcome to Owl Park');

    // stored in the core settings table under store_* keys
    const row = db.prepare("SELECT value FROM settings WHERE key = 'store_hero_title'").get();
    assert.equal(row.value, 'Welcome to Owl Park');

    // partial update leaves the other keys alone
    const r2 = await manager('PUT', '/api/storefront/settings', { hero_sub: 'Open late in summer' });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.settings.hero_title, 'Welcome to Owl Park');
    assert.equal(r2.data.settings.hero_sub, 'Open late in summer');
    assert.equal(r2.data.settings.accent, '#22aa66');
  });

  await t.test('section validation: kind + kind-shaped config required', async () => {
    let r = await manager('POST', '/api/storefront/sections', { title: 'X', kind: 'hero' });
    assert.equal(r.status, 400);
    r = await manager('POST', '/api/storefront/sections', { title: 'X', kind: 'products', config: {} });
    assert.equal(r.status, 400);
    r = await manager('POST', '/api/storefront/sections', { title: 'X', kind: 'products', config: { product_ids: [] } });
    assert.equal(r.status, 400);
    r = await manager('POST', '/api/storefront/sections', { title: 'X', kind: 'groups', config: {} });
    assert.equal(r.status, 400);
    r = await manager('POST', '/api/storefront/sections', { title: '', kind: 'html', config: { html: 'x' } });
    assert.equal(r.status, 400);
  });

  await t.test('curated landing: hero + sections with resolved product cards in order', async () => {
    const feed = await guest('GET', '/api/store/catalog');
    webProducts = feed.data.products;
    memberships = webProducts.filter((p) => p.kind === 'membership');
    assert.equal(memberships.length, 2);
    const adult = webProducts.find((p) => p.sku === 'ADULT');

    // "Go Annual" — hand-picked membership products (created second, sorts first)
    const goAnnual = await manager('POST', '/api/storefront/sections', {
      title: 'Go Annual',
      kind: 'products',
      sort: 1,
      config: { product_ids: memberships.map((p) => p.id) },
    });
    assert.equal(goAnnual.status, 200);
    assert.equal(goAnnual.data.section.kind, 'products');

    const dayTickets = await manager('POST', '/api/storefront/sections', {
      title: 'Day Tickets',
      kind: 'products',
      sort: 0,
      config: { product_ids: [adult.id] },
    });
    assert.equal(dayTickets.status, 200);

    const r = await guest('GET', '/api/store/layout');
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.hero_title, 'Welcome to Owl Park');
    assert.equal(r.data.sections.length, 2);
    // ordered by sort, not creation
    assert.deepEqual(r.data.sections.map((s) => s.title), ['Day Tickets', 'Go Annual']);
    // resolved, sellable-feed-shaped cards in the hand-picked order
    const annual = r.data.sections[1];
    assert.deepEqual(annual.products.map((p) => p.id), memberships.map((p) => p.id));
    for (const p of annual.products) {
      assert.ok(p.name && Number.isInteger(p.price_cents) && 'kind' in p && 'event_id' in p);
    }
    // config internals are never echoed to guests
    for (const s of r.data.sections) {
      assert.ok(!('config' in s), 'section config must not leak');
      assert.ok(!('active' in s));
    }
  });

  await t.test('html sections carry admin-authored html only', async () => {
    const r = await manager('POST', '/api/storefront/sections', {
      title: 'Plan your visit',
      kind: 'html',
      sort: 5,
      config: { html: '<p>Gates open at <strong>9am</strong>.</p>', extra_field: 'should vanish' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data.section.config), ['html']);

    const layout = await guest('GET', '/api/store/layout');
    const s = layout.data.sections.find((x) => x.title === 'Plan your visit');
    assert.equal(s.html, '<p>Gates open at <strong>9am</strong>.</p>');
    assert.ok(!('products' in s));
  });

  await t.test('guest safety: pos-only and inactive products are omitted', async () => {
    // a pos-only product, hand-picked into a section anyway
    const posOnly = await manager('POST', '/api/catalog/products', {
      sku: 'POSONLY', name: 'Cashier Special', kind: 'addon',
      price_cents: 500, tax_group_id: 1, channels: ['pos'],
    });
    assert.equal(posOnly.status, 200);
    // an active web product we then deactivate
    const shortLived = await manager('POST', '/api/catalog/products', {
      sku: 'GONE', name: 'Discontinued', kind: 'addon',
      price_cents: 300, tax_group_id: 1, channels: ['pos', 'web'],
    });
    assert.equal(shortLived.status, 200);

    const adult = webProducts.find((p) => p.sku === 'ADULT');
    const sneaky = await manager('POST', '/api/storefront/sections', {
      title: 'Back Door',
      kind: 'products',
      sort: 9,
      config: { product_ids: [posOnly.data.product.id, shortLived.data.product.id, adult.id] },
    });
    assert.equal(sneaky.status, 200);

    const off = await manager('PUT', `/api/catalog/products/${shortLived.data.product.id}`, { active: 0 });
    assert.equal(off.status, 200);

    const r = await guest('GET', '/api/store/layout');
    const s = r.data.sections.find((x) => x.title === 'Back Door');
    assert.deepEqual(s.products.map((p) => p.id), [adult.id], 'only the web-active product survives');
  });

  await t.test('group sections resolve via the groups module (or degrade to empty)', async () => {
    // seed a group directly (tables exist in migration 003; the groups module is a sibling team)
    const adult = webProducts.find((p) => p.sku === 'ADULT');
    const child = webProducts.find((p) => p.sku === 'CHILD');
    db.prepare("INSERT INTO item_groups (id, name, sort) VALUES (77, 'Day Tickets', 0)").run();
    for (const p of [adult, child].filter(Boolean)) {
      db.prepare('INSERT INTO product_groups (product_id, group_id) VALUES (?, 77)').run(p.id);
    }

    const r = await manager('POST', '/api/storefront/sections', {
      title: 'From a Group',
      kind: 'groups',
      sort: 3,
      config: { group_id: 77 },
    });
    assert.equal(r.status, 200);

    const layout = await guest('GET', '/api/store/layout');
    const s = layout.data.sections.find((x) => x.title === 'From a Group');
    assert.ok(s);
    if (ctx.modules.groups && typeof ctx.modules.groups.productIdsInGroup === 'function') {
      const expected = ctx.modules.groups.productIdsInGroup(db, 77);
      assert.deepEqual(s.products.map((p) => p.id).sort(), [...expected].sort());
      assert.ok(s.products.length > 0);
    } else {
      // graceful degradation until the groups module lands
      assert.deepEqual(s.products, []);
    }
  });

  await t.test('update, hide and delete sections', async () => {
    const list = await manager('GET', '/api/storefront/sections');
    const backDoor = list.data.sections.find((s) => s.title === 'Back Door');

    // hide → vanishes from the guest layout, still in the builder list
    const hide = await manager('PUT', `/api/storefront/sections/${backDoor.id}`, { active: 0 });
    assert.equal(hide.status, 200);
    assert.equal(hide.data.section.active, 0);
    let layout = await guest('GET', '/api/store/layout');
    assert.ok(!layout.data.sections.some((s) => s.id === backDoor.id));

    // retitle + re-kind: config must be re-validated for the new kind
    const rekind = await manager('PUT', `/api/storefront/sections/${backDoor.id}`, { kind: 'html' });
    assert.equal(rekind.status, 200);
    assert.deepEqual(Object.keys(rekind.data.section.config), ['html']);

    // delete
    const del = await manager('DELETE', `/api/storefront/sections/${backDoor.id}`);
    assert.equal(del.status, 200);
    const gone = await manager('PUT', `/api/storefront/sections/${backDoor.id}`, { title: 'zombie' });
    assert.equal(gone.status, 404);

    // guest-facing store still renders and stays offline-safe
    const page = await fetch(base + '/store/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.doesNotMatch(html, /https?:\/\/(?!localhost|127\.0\.0\.1)/);
    layout = await guest('GET', '/api/store/layout');
    assert.equal(layout.status, 200);
    assert.ok(layout.data.sections.length >= 3);
  });

  await t.test('builder page serves for signed-in staff pages', async () => {
    const res = await fetch(base + '/store-builder.html');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Store Builder/);
    assert.doesNotMatch(html, /https?:\/\/(?!localhost|127\.0\.0\.1)/);
  });
});

test('storefront: layout degrades gracefully without sibling modules', async () => {
  // isolated mount: no catalog, no groups → sections resolve to empty product lists
  const { openDb, migrate } = require('../server/core/db');
  const storefront = require('../server/modules/storefront');
  const db = openDb(tempDb());
  migrate(db, path.join(__dirname, '..', 'server', 'migrations'));

  db.prepare(`INSERT INTO store_sections (title, kind, sort, active, config)
              VALUES ('Picks', 'products', 0, 1, '{"product_ids":[1,2]}')`).run();
  db.prepare(`INSERT INTO store_sections (title, kind, sort, active, config)
              VALUES ('Grouped', 'groups', 1, 1, '{"group_id":1}')`).run();

  const layout = storefront.getLayout(db, { modules: {} });
  assert.equal(layout.sections.length, 2);
  assert.deepEqual(layout.sections[0].products, []);
  assert.deepEqual(layout.sections[1].products, []);
  db.close();
});
