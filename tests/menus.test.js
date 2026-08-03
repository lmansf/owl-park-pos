'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const { getActiveMenu } = require('../server/modules/menus');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer() {
  const { server, db, ctx } = createApp(tempDb());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, base, ctx };
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

async function seededProducts(manager) {
  const r = await manager('GET', '/api/catalog/products');
  assert.equal(r.status, 200);
  const by = (sku) => r.data.products.find((p) => p.sku === sku);
  return { adult: by('ADULT'), child: by('CHILD'), plntm: by('PLNTM'), all: r.data.products };
}

test('menus: roles and access', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const cashier = await login(base, 'cashier');

  await t.test('anonymous cannot read the active menu', async () => {
    const anon = client(base);
    const r = await anon('GET', '/api/menus/active');
    assert.equal(r.status, 401);
  });

  await t.test('any signed-in role reads the active menu', async () => {
    const r = await cashier('GET', '/api/menus/active');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.pages, []);
  });

  await t.test('cashier cannot use builder routes', async () => {
    assert.equal((await cashier('GET', '/api/menus/pages')).status, 403);
    assert.equal((await cashier('POST', '/api/menus/pages', { name: 'X' })).status, 403);
  });
});

test('menus: two-page menu with product + link buttons', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');
  const { adult, child, plntm } = await seededProducts(manager);

  let tickets, more;

  await t.test('build pages and buttons', async () => {
    tickets = (await manager('POST', '/api/menus/pages', { name: 'Tickets', sort: 1 })).data.page;
    more = (await manager('POST', '/api/menus/pages', { name: 'More', sort: 2 })).data.page;
    assert.ok(tickets.id && more.id);

    // out-of-order positions to prove position ordering
    const b2 = await manager('POST', `/api/menus/pages/${tickets.id}/buttons`, {
      product_id: child.id, position: 2,
    });
    assert.equal(b2.status, 200);
    const b1 = await manager('POST', `/api/menus/pages/${tickets.id}/buttons`, {
      product_id: adult.id, position: 1, label: 'Adult Day', color: '#2b6cb0', size: 'lg',
    });
    assert.equal(b1.status, 200);
    const link = await manager('POST', `/api/menus/pages/${tickets.id}/buttons`, {
      link_page_id: more.id, position: 3, label: 'More…',
    });
    assert.equal(link.status, 200);

    const back = await manager('POST', `/api/menus/pages/${more.id}/buttons`, {
      link_page_id: tickets.id, position: 1, label: 'Back',
    });
    assert.equal(back.status, 200);
    const timed = await manager('POST', `/api/menus/pages/${more.id}/buttons`, {
      product_id: plntm.id, position: 2,
    });
    assert.equal(timed.status, 200);
  });

  await t.test('active payload: both pages, buttons in position order, product join', async () => {
    const r = await cashier('GET', '/api/menus/active');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.pages.map((p) => p.name), ['Tickets', 'More']);

    const [tk, mo] = r.data.pages;
    assert.deepEqual(tk.buttons.map((b) => b.position), [1, 2, 3]);
    const adultBtn = tk.buttons[0];
    assert.equal(adultBtn.label, 'Adult Day');
    assert.equal(adultBtn.color, '#2b6cb0');
    assert.equal(adultBtn.size, 'lg');
    assert.equal(adultBtn.product_id, adult.id);
    assert.deepEqual(adultBtn.product, {
      name: adult.name, price_cents: adult.price_cents, kind: 'ticket', event_id: null,
    });
    // link button: no product join
    const linkBtn = tk.buttons[2];
    assert.equal(linkBtn.link_page_id, more.id);
    assert.equal(linkBtn.product, null);
    // event-linked product exposes event_id so POS can open the session picker
    const timedBtn = mo.buttons.find((b) => b.product_id === plntm.id);
    assert.ok(timedBtn.product.event_id, 'timed product carries event_id');
  });

  await t.test('pure getActiveMenu matches the HTTP payload', async () => {
    const r = await cashier('GET', '/api/menus/active');
    assert.deepEqual(getActiveMenu(db), r.data);
  });

  await t.test('inactive product buttons are omitted server-side', async () => {
    await manager('PUT', `/api/catalog/products/${child.id}`, { active: 0 });
    const r = await cashier('GET', '/api/menus/active');
    const tk = r.data.pages.find((p) => p.name === 'Tickets');
    assert.ok(!tk.buttons.some((b) => b.product_id === child.id));
    await manager('PUT', `/api/catalog/products/${child.id}`, { active: 1 });
    const r2 = await cashier('GET', '/api/menus/active');
    assert.ok(r2.data.pages[0].buttons.some((b) => b.product_id === child.id));
  });

  await t.test('inactive buttons are omitted; builder still lists them', async () => {
    const pages = (await manager('GET', '/api/menus/pages')).data.pages;
    const btn = pages.find((p) => p.id === tickets.id).buttons.find((b) => b.product_id === child.id);
    await manager('PUT', `/api/menus/buttons/${btn.id}`, { active: 0 });
    const active = (await cashier('GET', '/api/menus/active')).data;
    assert.ok(!active.pages[0].buttons.some((b) => b.id === btn.id));
    const builder = (await manager('GET', '/api/menus/pages')).data.pages;
    assert.ok(builder.find((p) => p.id === tickets.id).buttons.some((b) => b.id === btn.id));
    await manager('PUT', `/api/menus/buttons/${btn.id}`, { active: 1 });
  });

  await t.test('move = position swap', async () => {
    const pages = (await manager('GET', '/api/menus/pages')).data.pages;
    const tk = pages.find((p) => p.id === tickets.id);
    const adultBtn = tk.buttons.find((b) => b.product_id === adult.id); // pos 1
    const childBtn = tk.buttons.find((b) => b.product_id === child.id); // pos 2
    const r = await manager('POST', `/api/menus/buttons/${adultBtn.id}/move`, { position: 2 });
    assert.equal(r.status, 200);
    const after = (await cashier('GET', '/api/menus/active')).data.pages[0].buttons;
    assert.equal(after.find((b) => b.id === adultBtn.id).position, 2);
    assert.equal(after.find((b) => b.id === childBtn.id).position, 1);
    // move to a free position: plain move, no swap
    const r2 = await manager('POST', `/api/menus/buttons/${adultBtn.id}/move`, { position: 9 });
    assert.equal(r2.status, 200);
    const after2 = (await cashier('GET', '/api/menus/active')).data.pages[0].buttons;
    assert.equal(after2.find((b) => b.id === adultBtn.id).position, 9);
    assert.equal(after2.find((b) => b.id === childBtn.id).position, 1);
  });

  await t.test('deactivating the linked page drops the link button (no dead links)', async () => {
    await manager('PUT', `/api/menus/pages/${more.id}`, { active: 0 });
    const r = await cashier('GET', '/api/menus/active');
    assert.deepEqual(r.data.pages.map((p) => p.name), ['Tickets']);
    assert.ok(!r.data.pages[0].buttons.some((b) => b.link_page_id === more.id));
    await manager('PUT', `/api/menus/pages/${more.id}`, { active: 1 });
    const r2 = await cashier('GET', '/api/menus/active');
    assert.ok(r2.data.pages[0].buttons.some((b) => b.link_page_id === more.id));
  });

  await t.test('deleting a page removes its buttons and links pointing at it', async () => {
    const del = await manager('DELETE', `/api/menus/pages/${more.id}`);
    assert.equal(del.status, 200);
    assert.ok(del.data.removed_buttons >= 3, 'own buttons + inbound link removed');
    const orphan = db
      .prepare('SELECT COUNT(*) AS n FROM menu_buttons WHERE page_id = ? OR link_page_id = ?')
      .get(more.id, more.id).n;
    assert.equal(orphan, 0);
    const r = await cashier('GET', '/api/menus/active');
    assert.deepEqual(r.data.pages.map((p) => p.name), ['Tickets']);
    assert.ok(!r.data.pages[0].buttons.some((b) => b.link_page_id === more.id));
  });

  await t.test('fallback contract: all pages deactivated -> empty pages array', async () => {
    await manager('PUT', `/api/menus/pages/${tickets.id}`, { active: 0 });
    const r = await cashier('GET', '/api/menus/active');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.pages, []); // POS renders the auto-grid on this
  });
});

test('menus: designed button sells identically to the auto-grid path', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');
  const { adult } = await seededProducts(manager);

  const page = (await manager('POST', '/api/menus/pages', { name: 'Front' })).data.page;
  await manager('POST', `/api/menus/pages/${page.id}/buttons`, {
    product_id: adult.id, label: 'BIG ADULT', color: '#c53030', size: 'lg',
  });

  // POS resolves the tapped button through the sellable feed by product_id
  const feed = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const menu = (await cashier('GET', '/api/menus/active')).data;
  const btn = menu.pages[0].buttons[0];
  const viaMenu = feed.find((p) => p.id === btn.product_id);
  assert.ok(viaMenu, 'menu button product is in the pos feed');
  assert.equal(btn.product.price_cents, viaMenu.price_cents);

  // same order body either way -> same server-side totals
  const mkOrder = (pid) =>
    cashier('POST', '/api/pos/orders', { lines: [{ product_id: pid, qty: 2 }] });
  const fromMenu = await mkOrder(btn.product_id);
  const fromGrid = await mkOrder(adult.id);
  assert.equal(fromMenu.status, 200);
  assert.equal(fromGrid.status, 200);
  for (const k of ['subtotal_cents', 'tax_cents', 'discount_cents', 'total_cents']) {
    assert.equal(fromMenu.data.order[k], fromGrid.data.order[k], k);
  }
  assert.equal(fromMenu.data.order.lines[0].description, fromGrid.data.order.lines[0].description);
});

test('menus: validation', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const { adult } = await seededProducts(manager);
  const page = (await manager('POST', '/api/menus/pages', { name: 'P1' })).data.page;
  const page2 = (await manager('POST', '/api/menus/pages', { name: 'P2' })).data.page;

  await t.test('page name required', async () => {
    assert.equal((await manager('POST', '/api/menus/pages', { name: '  ' })).status, 400);
  });

  await t.test('button XOR: both / neither refs rejected', async () => {
    const both = await manager('POST', `/api/menus/pages/${page.id}/buttons`, {
      product_id: adult.id, link_page_id: page2.id,
    });
    assert.equal(both.status, 400);
    const neither = await manager('POST', `/api/menus/pages/${page.id}/buttons`, { label: 'x' });
    assert.equal(neither.status, 400);
  });

  await t.test('bad refs, self link, bad size', async () => {
    assert.equal((await manager('POST', `/api/menus/pages/${page.id}/buttons`, {
      product_id: 99999,
    })).status, 400);
    assert.equal((await manager('POST', `/api/menus/pages/${page.id}/buttons`, {
      link_page_id: 99999,
    })).status, 400);
    assert.equal((await manager('POST', `/api/menus/pages/${page.id}/buttons`, {
      link_page_id: page.id,
    })).status, 400);
    assert.equal((await manager('POST', `/api/menus/pages/${page.id}/buttons`, {
      product_id: adult.id, size: 'xl',
    })).status, 400);
    assert.equal((await manager('POST', '/api/menus/pages/99999/buttons', {
      product_id: adult.id,
    })).status, 404);
  });

  await t.test('position conflict -> 409; omitted position auto-appends', async () => {
    const a = await manager('POST', `/api/menus/pages/${page.id}/buttons`, { product_id: adult.id });
    assert.equal(a.status, 200);
    assert.equal(a.data.button.position, 1);
    const clash = await manager('POST', `/api/menus/pages/${page.id}/buttons`, {
      link_page_id: page2.id, position: 1,
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.data.error, 'position_taken');
    const b = await manager('POST', `/api/menus/pages/${page.id}/buttons`, { link_page_id: page2.id });
    assert.equal(b.status, 200);
    assert.equal(b.data.button.position, 2);
  });

  await t.test('edit switches type by nulling the other ref', async () => {
    const pages = (await manager('GET', '/api/menus/pages')).data.pages;
    const btn = pages.find((p) => p.id === page.id).buttons.find((b) => b.product_id === adult.id);
    const r = await manager('PUT', `/api/menus/buttons/${btn.id}`, {
      product_id: null, link_page_id: page2.id, label: 'Go',
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.button.link_page_id, page2.id);
    assert.equal(r.data.button.product_id, null);
  });
});

test('menus: generate from group and from catalog', async (t) => {
  const { server, base, ctx } = await startServer();
  t.after(() => server.close());
  const manager = await login(base, 'manager');
  const { adult, child, all } = await seededProducts(manager);
  const page = (await manager('POST', '/api/menus/pages', { name: 'Gen' })).data.page;

  const groupsPresent =
    ctx.modules.groups && typeof ctx.modules.groups.productIdsInGroup === 'function';

  if (groupsPresent) {
    await t.test('generate from an item group', async () => {
      const g = await manager('POST', '/api/groups', { name: 'Day Tickets' });
      assert.equal(g.status, 200, JSON.stringify(g.data));
      const gid = g.data.group.id;
      const put = await manager('PUT', `/api/groups/${gid}/products`, {
        product_ids: [adult.id, child.id],
      });
      assert.equal(put.status, 200);
      const gen = await manager('POST', `/api/menus/pages/${page.id}/generate`, { group_id: gid });
      assert.equal(gen.status, 200);
      assert.equal(gen.data.added, 2);
      const ids = gen.data.page.buttons.map((b) => b.product_id).sort((a, b) => a - b);
      assert.deepEqual(ids, [adult.id, child.id].sort((a, b) => a - b));
      // idempotent: nothing added twice
      const again = await manager('POST', `/api/menus/pages/${page.id}/generate`, { group_id: gid });
      assert.equal(again.data.added, 0);
    });
  } else {
    await t.test('group generation degrades cleanly when groups module is absent', async () => {
      const r = await manager('POST', `/api/menus/pages/${page.id}/generate`, { group_id: 1 });
      assert.equal(r.status, 400);
      assert.equal(r.data.error, 'groups_unavailable');
    });
  }

  await t.test('from-catalog fallback fills from the pos sellable feed', async () => {
    const p2 = (await manager('POST', '/api/menus/pages', { name: 'Gen2' })).data.page;
    const gen = await manager('POST', `/api/menus/pages/${p2.id}/generate`, { source: 'catalog' });
    assert.equal(gen.status, 200);
    const posSellable = all.filter(
      (p) => p.active && String(p.channels).split(',').includes('pos')
    );
    assert.equal(gen.data.added, posSellable.length);
    const positions = gen.data.page.buttons.map((b) => b.position);
    assert.deepEqual(positions, positions.slice().sort((a, b) => a - b));
  });

  await t.test('no source given -> 400', async () => {
    const r = await manager('POST', `/api/menus/pages/${page.id}/generate`, {});
    assert.equal(r.status, 400);
  });
});
