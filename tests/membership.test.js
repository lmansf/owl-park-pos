'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');

const DAY = (24 * 3600 * 1000);

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

function assertCloseToDaysFromNow(iso, days, label) {
  const expected = Date.now() + days * DAY;
  const actual = Date.parse(iso);
  assert.ok(
    Math.abs(actual - expected) < 10_000,
    `${label}: expected ~${days} days out, got ${iso}`
  );
}

test('membership: createOrRenewMember lifecycle', async (t) => {
  const { server, db, ctx } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const membership = ctx.modules.membership;

  await t.test('create issues GM- number, M- pass code, expiry = now + duration', () => {
    const m = membership.createOrRenewMember(db, {
      program_id: 1, name: 'Pat Parker', email: 'pat@example.com',
    });
    assert.match(m.member_no, /^GM-[A-Z2-9]{6}$/);
    assert.match(m.pass_code, /^M-[A-Z2-9]{10}$/);
    assert.equal(m.status, 'active');
    assert.equal(m.name, 'Pat Parker');
    assertCloseToDaysFromNow(m.expires_at, 365, 'new member expiry'); // Explorer Annual = 365d
  });

  await t.test('renewal extends, not resets (30d left + 365d = 395d out)', () => {
    const m = membership.createOrRenewMember(db, {
      program_id: 1, name: 'Renee Renewal', email: 'renee@example.com',
    });
    db.prepare('UPDATE members SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() + 30 * DAY).toISOString(), m.id);
    const renewed = membership.createOrRenewMember(db, {
      program_id: 1, name: 'Renee Renewal', email: 'renee@example.com',
    });
    assert.equal(renewed.id, m.id, 'same member record');
    assert.equal(renewed.pass_code, m.pass_code, 'same pass code');
    assert.equal(renewed.member_no, m.member_no, 'same member number');
    assertCloseToDaysFromNow(renewed.expires_at, 395, 'renewed expiry');
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM members WHERE lower(email) = ?')
      .get('renee@example.com').n;
    assert.equal(count, 1, 'no duplicate member created');
  });

  await t.test('renewing an expired member starts from now, not the old expiry', () => {
    const m = membership.createOrRenewMember(db, {
      program_id: 1, name: 'Les Lapsed', email: 'les@example.com',
    });
    db.prepare('UPDATE members SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 100 * DAY).toISOString(), m.id);
    const renewed = membership.createOrRenewMember(db, { program_id: 1, member_id: m.id });
    assert.equal(renewed.id, m.id);
    assertCloseToDaysFromNow(renewed.expires_at, 365, 'lapsed renewal expiry');
  });

  await t.test('explicit member_id renews that member even with a different buyer email', () => {
    const m = membership.createOrRenewMember(db, {
      program_id: 1, name: 'Gift Getter', email: 'getter@example.com',
    });
    const renewed = membership.createOrRenewMember(db, {
      program_id: 1, name: 'Gift Giver', email: 'giver@example.com', member_id: m.id,
    });
    assert.equal(renewed.id, m.id);
    assert.equal(renewed.name, 'Gift Getter', 'existing name not overwritten');
    const giver = db
      .prepare("SELECT COUNT(*) AS n FROM members WHERE email = 'giver@example.com'").get().n;
    assert.equal(giver, 0, 'no member created for the buyer');
  });

  await t.test('same email on a different program creates a separate member', () => {
    const a = membership.createOrRenewMember(db, {
      program_id: 1, name: 'Multi Fan', email: 'multi@example.com',
    });
    const b = membership.createOrRenewMember(db, {
      program_id: 2, name: 'Multi Fan', email: 'multi@example.com',
    });
    assert.notEqual(a.id, b.id);
  });

  await t.test('bad program / bad member_id rejected', () => {
    assert.throws(
      () => membership.createOrRenewMember(db, { program_id: 999, name: 'X', email: 'x@x.com' }),
      /No membership program/
    );
    assert.throws(
      () => membership.createOrRenewMember(db, { program_id: 1, member_id: 99999 }),
      /No member/
    );
  });
});

test('membership: members API — search, detail, edit, suspend/reinstate', async (t) => {
  const { server, db, ctx, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const membership = ctx.modules.membership;

  const m = membership.createOrRenewMember(db, {
    program_id: 2, name: 'Sasha Searchable', email: 'sasha@example.com',
  });

  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');
  const gate = await login(base, 'gate');
  const anon = client(base);

  await t.test('search requires sign-in; gate role is forbidden', async () => {
    assert.equal((await anon('GET', '/api/membership/members?q=sasha')).status, 401);
    assert.equal((await gate('GET', '/api/membership/members?q=sasha')).status, 403);
  });

  await t.test('search matches name, email, member number, and pass code', async () => {
    for (const q of ['searchab', 'sasha@example.com', m.member_no, m.pass_code]) {
      const r = await cashier('GET', '/api/membership/members?q=' + encodeURIComponent(q));
      assert.equal(r.status, 200);
      assert.ok(
        r.data.members.some((x) => x.id === m.id),
        `query "${q}" finds the member`
      );
    }
    const miss = await cashier('GET', '/api/membership/members?q=zzz-no-such');
    assert.equal(miss.data.members.length, 0);
  });

  await t.test('detail includes program info for the pass card', async () => {
    const r = await cashier('GET', `/api/membership/members/${m.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.member.program_name, 'Nova Family Annual');
    assert.equal(r.data.member.pass_code, m.pass_code);
    assert.equal((await cashier('GET', '/api/membership/members/99999')).status, 404);
  });

  await t.test('edit name/email', async () => {
    const r = await cashier('PUT', `/api/membership/members/${m.id}`, {
      name: 'Sasha Renamed', email: 'sasha2@example.com',
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.member.name, 'Sasha Renamed');
    assert.equal(r.data.member.email, 'sasha2@example.com');
    const bad = await cashier('PUT', `/api/membership/members/${m.id}`, { name: '' });
    assert.equal(bad.status, 400);
  });

  await t.test('suspend/reinstate is manager+; cashier is forbidden', async () => {
    assert.equal((await cashier('POST', `/api/membership/members/${m.id}/suspend`, {})).status, 403);
    const susp = await manager('POST', `/api/membership/members/${m.id}/suspend`, {});
    assert.equal(susp.status, 200);
    assert.equal(susp.data.member.status, 'suspended');
    const rein = await manager('POST', `/api/membership/members/${m.id}/reinstate`, {});
    assert.equal(rein.status, 200);
    assert.equal(rein.data.member.status, 'active');
  });

  await t.test('suspended members are not matched for email renewal', async () => {
    await manager('POST', `/api/membership/members/${m.id}/suspend`, {});
    const fresh = membership.createOrRenewMember(db, {
      program_id: 2, name: 'Sasha Renamed', email: 'sasha2@example.com',
    });
    assert.notEqual(fresh.id, m.id, 'new member created instead of renewing suspended one');
  });

  await t.test('settings expose venue name for the pass card', async () => {
    const r = await cashier('GET', '/api/membership/settings');
    assert.equal(r.status, 200);
    assert.equal(r.data.venue_name, 'Owl Park');
  });
});

test('membership: programs CRUD and price-from-catalog', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');

  await t.test('programs store no duplicate price; price flows from linked product', async () => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('membership_programs')").all()
      .map((r) => r.name);
    assert.ok(!cols.includes('price_cents'), 'membership_programs has no price column');

    let r = await manager('GET', '/api/membership/programs');
    const explorer = r.data.programs.find((p) => p.name === 'Explorer Annual');
    assert.equal(explorer.price_cents, 9900, 'price read from seeded MEM-EXP product');

    db.prepare("UPDATE products SET price_cents = 9900 WHERE sku = 'MEM-EXP'").run();
    r = await manager('GET', '/api/membership/programs');
    assert.equal(
      r.data.programs.find((p) => p.name === 'Explorer Annual').price_cents,
      9900,
      'new product price is reflected with no program-side edit'
    );
  });

  await t.test('cashier can list programs but not modify them', async () => {
    assert.equal((await cashier('GET', '/api/membership/programs')).status, 200);
    assert.equal(
      (await cashier('POST', '/api/membership/programs', { name: 'X', duration_days: 30 })).status,
      403
    );
  });

  await t.test('create, update, delete a program', async () => {
    const created = await manager('POST', '/api/membership/programs', {
      name: 'Summer Pass', duration_days: 90, benefits: 'All summer long',
    });
    assert.equal(created.status, 200);
    const id = created.data.program.id;
    assert.equal(created.data.program.duration_days, 90);

    const updated = await manager('PUT', `/api/membership/programs/${id}`, {
      name: 'Summer Pass+', duration_days: 120, benefits: 'Longer summer',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.program.name, 'Summer Pass+');
    assert.equal(updated.data.program.duration_days, 120);

    const bad = await manager('POST', '/api/membership/programs', { name: '', duration_days: 0 });
    assert.equal(bad.status, 400);

    const gone = await manager('DELETE', `/api/membership/programs/${id}`);
    assert.equal(gone.status, 200);
    const list = await manager('GET', '/api/membership/programs');
    assert.ok(!list.data.programs.some((p) => p.id === id));
  });

  await t.test('cannot delete a program with members or a linked product', async () => {
    const r = await manager('DELETE', '/api/membership/programs/1'); // seeded, linked to MEM-EXP
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'program_in_use');
  });
});
