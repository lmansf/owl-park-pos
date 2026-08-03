'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const catalog = require('../server/modules/catalog');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer() {
  const { server, db, ctx } = createApp(tempDb());
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

async function login(base, username) {
  const c = client(base);
  const r = await c('POST', '/api/auth/login', { username, password: username });
  assert.equal(r.status, 200, `login as ${username}`);
  return c;
}

async function findProduct(mgr, sku) {
  const list = await mgr('GET', '/api/catalog/products');
  const p = list.data.products.find((x) => x.sku === sku);
  assert.ok(p, `seeded product ${sku} exists`);
  return p;
}

test('item-config: single-product read API', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');

  await t.test('requires sign-in', async () => {
    const anon = client(base);
    const r = await anon('GET', '/api/catalog/products/1');
    assert.equal(r.status, 401);
  });

  await t.test('cashier cannot open the item editor API', async () => {
    const r = await cashier('GET', '/api/catalog/products/1');
    assert.equal(r.status, 403);
  });

  await t.test('manager gets the full seeded Adult Day Ticket in one payload', async () => {
    const adult = await findProduct(manager, 'ADULT');
    const r = await manager('GET', `/api/catalog/products/${adult.id}`);
    assert.equal(r.status, 200);
    const p = r.data.product;
    assert.equal(p.sku, 'ADULT');
    assert.equal(p.price_cents, 2995);
    assert.equal(p.kind, 'ticket');
    assert.equal(p.tax_rate_bp, 625);
    assert.ok(p.tax_group_name, 'joined tax group name present');
    assert.ok(String(p.channels).includes('pos'), 'channels field present for the editor');
    assert.equal(p.has_sales, 0);
    // enrichment keys always present; value depends on sibling-module presence
    assert.ok('groups' in r.data, 'groups key present');
    assert.ok('price_override' in r.data, 'price_override key present');
    assert.ok(r.data.groups === null || Array.isArray(r.data.groups));
    assert.ok(r.data.price_override === null || typeof r.data.price_override === 'object');
  });

  await t.test('unknown id -> 404, garbage id -> 400', async () => {
    const missing = await manager('GET', '/api/catalog/products/999999');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, 'not_found');
    const garbage = await manager('GET', '/api/catalog/products/abc');
    assert.equal(garbage.status, 400);
  });
});

test('item-config: sibling widgets degrade without modules, enrich with them', async (t) => {
  const { server, ctx, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const adult = await findProduct(manager, 'ADULT');

  await t.test('groups/pricing absent -> nulls, never an error', async () => {
    // simulate the isolated-team world regardless of which siblings have landed
    delete ctx.modules.groups;
    delete ctx.modules.pricing;
    const r = await manager('GET', `/api/catalog/products/${adult.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.groups, null);
    assert.equal(r.data.price_override, null);
  });

  await t.test('groups/pricing present -> membership flags and active override', async () => {
    ctx.modules.groups = {
      listGroups: () => [
        { id: 1, name: 'Day Tickets', sort: 0, color: '#4da3ff', active: 1, product_count: 2 },
        { id: 2, name: 'Extras', sort: 1, color: '', active: 1, product_count: 0 },
      ],
      productIdsInGroup: (db, gid) => (gid === 1 ? [adult.id, 424242] : []),
    };
    ctx.modules.pricing = {
      resolvePrice: (db, pid) =>
        pid === adult.id
          ? { price_cents: 1999, program_id: 7, program_name: 'Summer Sale' }
          : null,
    };
    const r = await manager('GET', `/api/catalog/products/${adult.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.groups.length, 2);
    const [g1, g2] = r.data.groups;
    assert.equal(g1.member, 1);
    assert.deepEqual(g1.product_ids, [adult.id, 424242]);
    assert.equal(g2.member, 0);
    assert.equal(g2.name, 'Extras');
    assert.deepEqual(r.data.price_override, {
      price_cents: 1999, program_id: 7, program_name: 'Summer Sale',
    });
  });

  await t.test('misbehaving sibling module degrades to null instead of 500', async () => {
    ctx.modules.groups = {
      listGroups: () => { throw new Error('boom'); },
      productIdsInGroup: () => [],
    };
    ctx.modules.pricing = {
      resolvePrice: () => { throw new Error('boom'); },
    };
    const r = await manager('GET', `/api/catalog/products/${adult.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.groups, null);
    assert.equal(r.data.price_override, null);
  });
});

test('item-config: new-item and edit flows the page relies on', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');

  let created;
  await t.test('no id -> create via POST, then readable by id', async () => {
    const r = await manager('POST', '/api/catalog/products', {
      sku: 'CABANA', name: 'Cabana Rental', kind: 'addon',
      price_cents: 7500, tax_group_id: 1, validity_days: 1, max_uses: 1,
      channels: ['pos'],
    });
    assert.equal(r.status, 200);
    created = r.data.product;
    const read = await manager('GET', `/api/catalog/products/${created.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.data.product.sku, 'CABANA');
    assert.equal(read.data.product.channels, 'pos');
  });

  await t.test('edit round-trip: price, channels, active persist', async () => {
    const upd = await manager('PUT', `/api/catalog/products/${created.id}`, {
      price_cents: 8200, channels: ['pos', 'web'], active: 0,
    });
    assert.equal(upd.status, 200);
    const read = await manager('GET', `/api/catalog/products/${created.id}`);
    assert.equal(read.data.product.price_cents, 8200);
    assert.equal(read.data.product.channels, 'pos,web');
    assert.equal(read.data.product.active, 0);
  });
});

test('item-config: standalone discounts editor — deactivate stops redemption', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');

  await t.test('manager creates and edits a code from the discounts page', async () => {
    const r = await manager('POST', '/api/catalog/discounts', {
      code: 'GATE15', name: 'Gate special', kind: 'percent', value: 15,
    });
    assert.equal(r.status, 200);
    const edit = await manager('PUT', `/api/catalog/discounts/${r.data.discount.id}`, {
      name: 'Gate special (summer)',
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.data.discount.name, 'Gate special (summer)');
    assert.equal(edit.data.discount.value, 15);
  });

  await t.test('deactivated SAVE10 gets the standard invalid-code error at POS', async () => {
    const list = await manager('GET', '/api/catalog/discounts');
    const save10 = list.data.discounts.find((d) => d.code === 'SAVE10');
    assert.ok(save10, 'seeded SAVE10 exists');

    const off = await manager('PUT', `/api/catalog/discounts/${save10.id}`, { active: 0 });
    assert.equal(off.status, 200);

    const apply = await cashier('POST', '/api/catalog/discounts/validate', { code: 'SAVE10' });
    assert.equal(apply.status, 404);
    assert.equal(apply.data.error, 'bad_discount');

    // reactivation restores redemption
    await manager('PUT', `/api/catalog/discounts/${save10.id}`, { active: 1 });
    const again = await cashier('POST', '/api/catalog/discounts/validate', { code: 'SAVE10' });
    assert.equal(again.status, 200);
    assert.equal(again.data.discount.value, 10);
  });
});

test('item-config: catalog contract stays intact (additive only)', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');

  await t.test('pre-existing exports unchanged', () => {
    assert.equal(typeof catalog.mount, 'function');
    assert.equal(typeof catalog.getSellable, 'function');
    assert.equal(typeof catalog.validateDiscount, 'function');
    const rows = catalog.getSellable(db, 'pos');
    assert.ok(rows.length >= 7);
    assert.ok(rows.every((r) => r.tax_rate_bp !== undefined && r.channels === undefined));
    assert.equal(catalog.validateDiscount(db, 'save10').value, 10);
  });

  await t.test('pre-existing routes unchanged', async () => {
    const feed = await manager('GET', '/api/catalog/sellable?channel=pos');
    assert.equal(feed.status, 200);
    assert.ok(feed.data.products.length >= 7);
    const list = await manager('GET', '/api/catalog/products');
    assert.equal(list.status, 200);
    const del = await manager('DELETE', '/api/catalog/products/1');
    assert.equal(del.status, 404, 'still no delete route');
  });
});
