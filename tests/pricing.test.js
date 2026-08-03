'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const { resolvePrice } = require('../server/modules/pricing');

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

// Local YYYY-MM-DD, offset in days from today (server-local == test-local here).
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

test('pricing: program management (spec: Winter pricing)', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await c('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  const adult = db.prepare("SELECT id, price_cents FROM products WHERE sku = 'ADULT'").get();
  assert.ok(adult, 'seeded Adult product exists');
  assert.equal(adult.price_cents, 2995);

  let winterId;

  await t.test('create Winter covering today at priority 10', async () => {
    const r = await c('POST', '/api/pricing/programs', {
      name: 'Winter',
      starts_on: localDate(-1),
      ends_on: localDate(7),
      priority: 10,
    });
    assert.equal(r.status, 200);
    winterId = r.data.program.id;
    assert.equal(r.data.program.live, 1);
    assert.equal(r.data.program.entry_count, 0);
  });

  await t.test('store Adult override as 2495 (only overridden products stored)', async () => {
    const r = await c('PUT', `/api/pricing/programs/${winterId}/entries`, {
      entries: [{ product_id: adult.id, price_cents: 2495 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.entries.length, 1);
    assert.equal(r.data.entries[0].price_cents, 2495);
    assert.equal(r.data.entries[0].base_price_cents, 2995);
    const row = db
      .prepare('SELECT price_cents FROM price_program_entries WHERE program_id = ? AND product_id = ?')
      .get(winterId, adult.id);
    assert.equal(row.price_cents, 2495);
  });

  await t.test('list shows Winter as live today with 1 override', async () => {
    const r = await c('GET', '/api/pricing/programs');
    assert.equal(r.status, 200);
    const winter = r.data.programs.find((p) => p.id === winterId);
    assert.equal(winter.live, 1);
    assert.equal(winter.entry_count, 1);
    assert.equal(r.data.today, localDate(0));
  });

  await t.test('a past program is not live', async () => {
    const r = await c('POST', '/api/pricing/programs', {
      name: 'Last month', starts_on: localDate(-40), ends_on: localDate(-30),
    });
    assert.equal(r.data.program.live, 0);
  });

  await t.test('deactivating kills liveness; update restores it', async () => {
    let r = await c('PUT', `/api/pricing/programs/${winterId}`, { active: 0 });
    assert.equal(r.data.program.live, 0);
    r = await c('PUT', `/api/pricing/programs/${winterId}`, { active: 1 });
    assert.equal(r.data.program.live, 1);
    assert.equal(r.data.program.name, 'Winter'); // merge-over-existing keeps fields
  });

  await t.test('entries PUT replaces the whole set', async () => {
    const child = db.prepare("SELECT id FROM products WHERE sku = 'CHILD'").get();
    const r = await c('PUT', `/api/pricing/programs/${winterId}/entries`, {
      entries: [{ product_id: child.id, price_cents: 1295 }],
    });
    assert.equal(r.data.entries.length, 1);
    assert.equal(r.data.entries[0].product_id, child.id);
    assert.equal(resolvePrice(db, adult.id, new Date().toISOString()), null);
  });

  await t.test('delete removes program and its entries', async () => {
    const r = await c('DELETE', `/api/pricing/programs/${winterId}`);
    assert.equal(r.status, 200);
    const gone = await c('GET', `/api/pricing/programs/${winterId}`);
    assert.equal(gone.status, 404);
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM price_program_entries WHERE program_id = ?')
      .get(winterId).n;
    assert.equal(n, 0);
  });
});

test('pricing: resolvePrice is deterministic', async (t) => {
  const { server, db } = await startServer();
  t.after(() => server.close());

  const adult = db.prepare("SELECT id FROM products WHERE sku = 'ADULT'").get();
  const child = db.prepare("SELECT id FROM products WHERE sku = 'CHILD'").get();
  const nowIso = new Date().toISOString();

  const insProgram = db.prepare(
    'INSERT INTO price_programs (name, starts_on, ends_on, priority, active) VALUES (?, ?, ?, ?, ?)'
  );
  const insEntry = db.prepare(
    'INSERT INTO price_program_entries (program_id, product_id, price_cents) VALUES (?, ?, ?)'
  );
  const mkProgram = (name, from, to, priority, active = 1) =>
    Number(insProgram.run(name, from, to, priority, active).lastInsertRowid);

  await t.test('no programs -> null', () => {
    assert.equal(resolvePrice(db, adult.id, nowIso), null);
  });

  const hi = mkProgram('High', localDate(-1), localDate(1), 10);
  const lo = mkProgram('Low', localDate(-1), localDate(1), 5);
  insEntry.run(hi, adult.id, 2495);
  insEntry.run(lo, adult.id, 2295);

  await t.test('spec: overlap resolved by priority (10 beats 5)', () => {
    const r = resolvePrice(db, adult.id, nowIso);
    assert.deepEqual(r, { price_cents: 2495, program_id: hi, program_name: 'High' });
  });

  await t.test('equal priority -> lowest program id wins', () => {
    const hi2 = mkProgram('High2', localDate(-1), localDate(1), 10);
    insEntry.run(hi2, adult.id, 1999);
    const r = resolvePrice(db, adult.id, nowIso);
    assert.equal(r.program_id, hi);
    assert.equal(r.price_cents, 2495);
    db.prepare('DELETE FROM price_program_entries WHERE program_id = ?').run(hi2);
    db.prepare('DELETE FROM price_programs WHERE id = ?').run(hi2);
  });

  await t.test('inactive programs never apply', () => {
    db.prepare('UPDATE price_programs SET active = 0 WHERE id = ?').run(hi);
    const r = resolvePrice(db, adult.id, nowIso);
    assert.equal(r.program_id, lo);
    assert.equal(r.price_cents, 2295);
    db.prepare('UPDATE price_programs SET active = 1 WHERE id = ?').run(hi);
  });

  await t.test('product without an entry -> null', () => {
    assert.equal(resolvePrice(db, child.id, nowIso), null);
  });

  await t.test('date bounds are local days, inclusive on both ends', () => {
    const single = mkProgram('OneDay', localDate(0), localDate(0), 99);
    insEntry.run(single, child.id, 777);
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0); // local midnight
    const dayEnd = new Date();
    dayEnd.setHours(23, 59, 59, 999); // last local ms of the day
    assert.equal(resolvePrice(db, child.id, dayStart.toISOString()).price_cents, 777);
    assert.equal(resolvePrice(db, child.id, dayEnd.toISOString()).price_cents, 777);
    // outside the window on both sides
    const before = new Date(dayStart.getTime() - 1000);
    const after = new Date(dayEnd.getTime() + 1000);
    assert.equal(resolvePrice(db, child.id, before.toISOString()), null);
    assert.equal(resolvePrice(db, child.id, after.toISOString()), null);
  });

  await t.test('garbage atIso -> null, never throws', () => {
    assert.equal(resolvePrice(db, adult.id, 'not-a-date'), null);
  });
});

test('pricing: auth and validation', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());

  const adult = db.prepare("SELECT id FROM products WHERE sku = 'ADULT'").get();

  await t.test('unauthenticated list is 401', async () => {
    const anon = client(base);
    const r = await anon('GET', '/api/pricing/programs');
    assert.equal(r.status, 401);
  });

  await t.test('cashier can read the list but not mutate', async () => {
    const cashier = client(base);
    await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
    const list = await cashier('GET', '/api/pricing/programs');
    assert.equal(list.status, 200);
    const create = await cashier('POST', '/api/pricing/programs', {
      name: 'Nope', starts_on: localDate(0), ends_on: localDate(0),
    });
    assert.equal(create.status, 403);
  });

  const c = client(base);
  await c('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  await t.test('rejects malformed programs', async () => {
    const cases = [
      { name: '', starts_on: localDate(0), ends_on: localDate(0) },
      { name: 'X', starts_on: '2026/01/01', ends_on: localDate(0) },
      { name: 'X', starts_on: localDate(0), ends_on: 'soon' },
      { name: 'X', starts_on: localDate(1), ends_on: localDate(0) }, // ends before starts
      { name: 'X', starts_on: localDate(0), ends_on: localDate(0), priority: 1.5 },
    ];
    for (const body of cases) {
      const r = await c('POST', '/api/pricing/programs', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  await t.test('rejects malformed entries', async () => {
    const made = await c('POST', '/api/pricing/programs', {
      name: 'Val', starts_on: localDate(0), ends_on: localDate(0),
    });
    const id = made.data.program.id;
    const cases = [
      {}, // no entries array
      { entries: [{ product_id: adult.id, price_cents: -1 }] },
      { entries: [{ product_id: adult.id, price_cents: 10.5 }] },
      { entries: [{ product_id: 999999, price_cents: 100 }] },
      { entries: [
        { product_id: adult.id, price_cents: 100 },
        { product_id: adult.id, price_cents: 200 }, // duplicate product
      ] },
    ];
    for (const body of cases) {
      const r = await c('PUT', `/api/pricing/programs/${id}/entries`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    // failed PUTs must not have partially written anything
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM price_program_entries WHERE program_id = ?')
      .get(id).n;
    assert.equal(n, 0);
  });

  await t.test('unknown program id is 404', async () => {
    const r = await c('PUT', '/api/pricing/programs/424242/entries', { entries: [] });
    assert.equal(r.status, 404);
  });
});
