'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const groupsMod = require('../server/modules/groups');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer() {
  const { server, db } = createApp(tempDb());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, base };
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

test('groups: CRUD, assignment, exports, audit', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const mgr = client(base);
  await mgr('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  const skus = ['ADULT', 'CHILD', 'SENIOR'];
  const dayTicketIds = skus.map(
    (sku) => db.prepare('SELECT id FROM products WHERE sku = ?').get(sku).id
  );
  let groupId = null;

  await t.test('unauthenticated GET /api/groups is 401', async () => {
    const anon = client(base);
    const r = await anon('GET', '/api/groups');
    assert.equal(r.status, 401);
  });

  await t.test('create "Day Tickets" and assign Adult/Child/Senior', async () => {
    const created = await mgr('POST', '/api/groups', {
      name: 'Day Tickets', sort: 1, color: '#5a78ff',
    });
    assert.equal(created.status, 200);
    groupId = created.data.group.id;
    assert.equal(created.data.group.product_count, 0);

    const assign = await mgr('PUT', `/api/groups/${groupId}/products`, {
      product_ids: dayTicketIds,
    });
    assert.equal(assign.status, 200);
    assert.deepEqual(assign.data.product_ids.sort((a, b) => a - b),
      [...dayTicketIds].sort((a, b) => a - b));

    const list = await mgr('GET', '/api/groups');
    assert.equal(list.status, 200);
    const g = list.data.groups.find((x) => x.id === groupId);
    assert.equal(g.product_count, 3);

    // picker source reflects membership
    const detail = await mgr('GET', `/api/groups/${groupId}`);
    assert.deepEqual(detail.data.product_ids.sort((a, b) => a - b),
      [...dayTicketIds].sort((a, b) => a - b));
  });

  await t.test('a product may belong to many groups', async () => {
    const second = await mgr('POST', '/api/groups', { name: 'Adults Only' });
    const sid = second.data.group.id;
    await mgr('PUT', `/api/groups/${sid}/products`, { product_ids: [dayTicketIds[0]] });
    const forProduct = groupsMod.groupsForProduct(db, dayTicketIds[0]);
    assert.deepEqual(forProduct.map((g) => g.name).sort(), ['Adults Only', 'Day Tickets']);
  });

  await t.test('exports match the design contract', async () => {
    const rows = groupsMod.listGroups(db);
    const g = rows.find((x) => x.id === groupId);
    assert.ok(g, 'listGroups includes the group');
    for (const k of ['id', 'name', 'sort', 'color', 'active', 'product_count']) {
      assert.ok(k in g, `listGroups rows expose ${k}`);
    }
    assert.equal(g.product_count, 3);
    assert.deepEqual(groupsMod.productIdsInGroup(db, groupId),
      [...dayTicketIds].sort((a, b) => a - b));
    assert.deepEqual(groupsMod.productIdsInGroup(db, 999999), []);
  });

  await t.test('re-assignment replaces membership and audits new list', async () => {
    const newIds = dayTicketIds.slice(0, 2);
    const r = await mgr('PUT', `/api/groups/${groupId}/products`, { product_ids: newIds });
    assert.equal(r.status, 200);
    assert.equal(groupsMod.productIdsInGroup(db, groupId).length, 2);

    const row = db.prepare(
      "SELECT detail FROM audit_log WHERE action = 'groups.assign' ORDER BY id DESC LIMIT 1"
    ).get();
    assert.ok(row, 'assignment writes an audit row');
    const detail = JSON.parse(row.detail);
    assert.equal(detail.group_id, groupId);
    assert.deepEqual(detail.product_ids.sort((a, b) => a - b),
      [...newIds].sort((a, b) => a - b));
  });

  await t.test('create/edit write audit rows', async () => {
    await mgr('PUT', `/api/groups/${groupId}`, { name: 'Day Tickets (renamed)' });
    const actions = db.prepare(
      "SELECT action FROM audit_log WHERE action LIKE 'groups.%'"
    ).all().map((r) => r.action);
    assert.ok(actions.includes('groups.create'));
    assert.ok(actions.includes('groups.update'));
  });

  await t.test('delete = deactivate; hidden by default, ?all=1 shows, exports go empty', async () => {
    const del = await mgr('DELETE', `/api/groups/${groupId}`);
    assert.equal(del.status, 200);
    assert.equal(del.data.group.active, 0);

    const dflt = await mgr('GET', '/api/groups');
    assert.ok(!dflt.data.groups.some((g) => g.id === groupId), 'default listing excludes inactive');

    const all = await mgr('GET', '/api/groups?all=1');
    const g = all.data.groups.find((x) => x.id === groupId);
    assert.ok(g, '?all=1 includes inactive');
    assert.equal(g.active, 0);
    assert.equal(g.product_count, 2, 'membership rows survive deactivation');

    // consumers degrade gracefully: no rows, no errors
    assert.ok(!groupsMod.listGroups(db).some((x) => x.id === groupId));
    assert.deepEqual(groupsMod.productIdsInGroup(db, groupId), []);
    assert.ok(!groupsMod.groupsForProduct(db, dayTicketIds[0]).some((x) => x.id === groupId));

    // reactivate restores membership intact
    await mgr('PUT', `/api/groups/${groupId}`, { active: 1 });
    assert.equal(groupsMod.productIdsInGroup(db, groupId).length, 2);
  });

  await t.test('validation: bad payloads rejected', async () => {
    assert.equal((await mgr('POST', '/api/groups', { name: '   ' })).status, 400);
    assert.equal((await mgr('POST', '/api/groups', { name: 'X', sort: 'abc' })).status, 400);
    assert.equal(
      (await mgr('PUT', `/api/groups/${groupId}/products`, { product_ids: 'nope' })).status, 400);
    assert.equal(
      (await mgr('PUT', `/api/groups/${groupId}/products`, { product_ids: [999999] })).status, 400);
    // strict ints: Number() would coerce true->1 and [2]->2, quietly assigning
    // whichever product happens to hold that id
    const before = groupsMod.productIdsInGroup(db, groupId).slice().sort((a, b) => a - b);
    for (const v of [true, [dayTicketIds[0]], null, '', {}]) {
      assert.equal(
        (await mgr('PUT', `/api/groups/${groupId}/products`, { product_ids: [v] })).status, 400,
        `product_ids [${JSON.stringify(v)}] must be rejected`);
    }
    for (const v of [true, [2], '']) {
      assert.equal((await mgr('POST', '/api/groups', { name: 'X', sort: v })).status, 400,
        `sort ${JSON.stringify(v)} must be rejected`);
    }
    assert.deepEqual(groupsMod.productIdsInGroup(db, groupId).slice().sort((a, b) => a - b), before,
      'rejected assignments must not touch membership');
    assert.equal((await mgr('GET', '/api/groups/999999')).status, 404);
    assert.equal((await mgr('PUT', '/api/groups/999999', { name: 'Z' })).status, 404);
    assert.equal((await mgr('DELETE', '/api/groups/999999')).status, 404);
  });

  await t.test('roles: cashier reads, cannot write', async () => {
    const cash = client(base);
    await cash('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
    assert.equal((await cash('GET', '/api/groups')).status, 200);
    assert.equal((await cash('POST', '/api/groups', { name: 'Nope' })).status, 403);
    assert.equal((await cash('PUT', `/api/groups/${groupId}`, { name: 'Nope' })).status, 403);
    assert.equal((await cash('DELETE', `/api/groups/${groupId}`)).status, 403);
    assert.equal(
      (await cash('PUT', `/api/groups/${groupId}/products`, { product_ids: [] })).status, 403);
  });
});
