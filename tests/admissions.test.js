'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-adm-test-'));
  return path.join(dir, 'test.db');
}

async function startServer() {
  const { server, db } = createApp(tempDb());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, base };
}

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

const HOUR = 3600_000;
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// Tickets require an order + order_line (FKs). Insert minimal ones directly —
// admissions must work without the pos module.
function mkTicket(db, { code, productId = 1, sessionId = null, status = 'valid',
  uses = 1, from, to, holder = '' }) {
  const nowMs = Date.now();
  const order = db.prepare(
    "INSERT INTO orders (channel, status, created_at) VALUES ('pos', 'paid', ?)"
  ).run(iso(nowMs));
  const line = db.prepare(
    `INSERT INTO order_lines (order_id, product_id, description, qty, unit_price_cents)
     VALUES (?, ?, 'test line', 1, 0)`
  ).run(order.lastInsertRowid, productId);
  db.prepare(
    `INSERT INTO tickets (code, order_line_id, product_id, event_session_id, status,
       uses_remaining, valid_from, valid_to, holder_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, line.lastInsertRowid, productId, sessionId, status, uses,
    from || iso(nowMs - HOUR), to || iso(nowMs + 30 * DAY), holder);
}

function mkMember(db, { pass, name, expires, status = 'active', programId = 1 }) {
  db.prepare(
    `INSERT INTO members (member_no, name, email, program_id, pass_code, joined_at, expires_at, status)
     VALUES (?, ?, '', ?, ?, ?, ?, ?)`
  ).run('GM-' + pass.slice(-6), name, programId, pass, iso(Date.now() - DAY),
    expires || iso(Date.now() + 365 * DAY), status);
}

function mkSession(db, startMs, endMs) {
  const r = db.prepare(
    'INSERT INTO event_sessions (event_id, starts_at, ends_at, capacity) VALUES (1, ?, ?, 40)'
  ).run(iso(startMs), iso(endMs));
  return r.lastInsertRowid;
}

function admitCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM admits').get().n;
}

test('admissions: scan validation rules', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await c('POST', '/api/auth/login', { username: 'gate', password: 'gate' });

  await t.test('unknown code -> denied unknown, admits row still written', async () => {
    const before = admitCount(db);
    const r = await c('POST', '/api/admissions/scan', { code: 'T-NOPENOPE99', gate: 'main' });
    assert.equal(r.status, 200);
    assert.equal(r.data.result, 'denied');
    assert.equal(r.data.kind, 'unknown');
    assert.equal(r.data.reason, 'unknown');
    assert.equal(admitCount(db), before + 1);
    const row = db.prepare('SELECT * FROM admits ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.code, 'T-NOPENOPE99');
    assert.equal(row.result, 'denied');
    assert.equal(row.reason, 'unknown');
  });

  await t.test('double entry: single-use ticket admits once, then exhausted', async () => {
    mkTicket(db, { code: 'T-SINGLEUSE1', holder: 'Sam Solo' });
    const first = await c('POST', '/api/admissions/scan', { code: 'T-SINGLEUSE1' });
    assert.equal(first.data.result, 'ok');
    assert.equal(first.data.kind, 'ticket');
    assert.equal(first.data.reason, null);
    assert.equal(first.data.display_name, 'Sam Solo');
    const tk = db.prepare("SELECT * FROM tickets WHERE code = 'T-SINGLEUSE1'").get();
    assert.equal(tk.uses_remaining, 0);
    assert.equal(tk.status, 'used');
    const second = await c('POST', '/api/admissions/scan', { code: 'T-SINGLEUSE1' });
    assert.equal(second.data.result, 'denied');
    assert.equal(second.data.reason, 'exhausted');
  });

  await t.test('multi-use ticket stays valid until zero uses', async () => {
    mkTicket(db, { code: 'T-MULTIUSE22', uses: 2 });
    const r1 = await c('POST', '/api/admissions/scan', { code: 'T-MULTIUSE22' });
    assert.equal(r1.data.result, 'ok');
    let tk = db.prepare("SELECT * FROM tickets WHERE code = 'T-MULTIUSE22'").get();
    assert.equal(tk.uses_remaining, 1);
    assert.equal(tk.status, 'valid');
    const r2 = await c('POST', '/api/admissions/scan', { code: 'T-MULTIUSE22' });
    assert.equal(r2.data.result, 'ok');
    tk = db.prepare("SELECT * FROM tickets WHERE code = 'T-MULTIUSE22'").get();
    assert.equal(tk.uses_remaining, 0);
    assert.equal(tk.status, 'used');
    const r3 = await c('POST', '/api/admissions/scan', { code: 'T-MULTIUSE22' });
    assert.equal(r3.data.reason, 'exhausted');
  });

  await t.test('void ticket -> denied void', async () => {
    mkTicket(db, { code: 'T-VOIDVOID33', status: 'void' });
    const r = await c('POST', '/api/admissions/scan', { code: 'T-VOIDVOID33' });
    assert.equal(r.data.result, 'denied');
    assert.equal(r.data.reason, 'void');
  });

  await t.test('expired ticket -> denied expired', async () => {
    mkTicket(db, {
      code: 'T-EXPIRED444',
      from: iso(Date.now() - 10 * DAY), to: iso(Date.now() - DAY),
    });
    const r = await c('POST', '/api/admissions/scan', { code: 'T-EXPIRED444' });
    assert.equal(r.data.result, 'denied');
    assert.equal(r.data.reason, 'expired');
  });

  await t.test('future ticket -> denied not_yet_valid', async () => {
    mkTicket(db, {
      code: 'T-TOMORROW55',
      from: iso(Date.now() + DAY), to: iso(Date.now() + 30 * DAY),
    });
    const r = await c('POST', '/api/admissions/scan', { code: 'T-TOMORROW55' });
    assert.equal(r.data.result, 'denied');
    assert.equal(r.data.reason, 'not_yet_valid');
  });

  await t.test('early arrival for session ticket -> wrong_session_time, stays valid', async () => {
    // Session starts 5h from now (e.g. scanning at 09:00 for a 14:00 show).
    const sid = mkSession(db, Date.now() + 5 * HOUR, Date.now() + 5 * HOUR + 45 * 60_000);
    mkTicket(db, { code: 'T-EARLYBIRD6', productId: 4, sessionId: sid });
    const r = await c('POST', '/api/admissions/scan', { code: 'T-EARLYBIRD6' });
    assert.equal(r.data.result, 'denied');
    assert.equal(r.data.reason, 'wrong_session_time');
    const tk = db.prepare("SELECT * FROM tickets WHERE code = 'T-EARLYBIRD6'").get();
    assert.equal(tk.status, 'valid');
    assert.equal(tk.uses_remaining, 1); // not consumed by the denial
  });

  await t.test('session ticket inside entry window (start-30min..end) -> ok', async () => {
    // Session starts in 20 minutes: within the 30-minute early-entry grace.
    const sid = mkSession(db, Date.now() + 20 * 60_000, Date.now() + 65 * 60_000);
    mkTicket(db, { code: 'T-ONTIME9999', productId: 4, sessionId: sid });
    const r = await c('POST', '/api/admissions/scan', { code: 'T-ONTIME9999' });
    assert.equal(r.data.result, 'ok');
  });

  await t.test('session ticket after session end -> wrong_session_time', async () => {
    const sid = mkSession(db, Date.now() - 3 * HOUR, Date.now() - 2 * HOUR);
    mkTicket(db, { code: 'T-TOOLATE999', productId: 4, sessionId: sid });
    const r = await c('POST', '/api/admissions/scan', { code: 'T-TOOLATE999' });
    assert.equal(r.data.result, 'denied');
    assert.equal(r.data.reason, 'wrong_session_time');
  });

  await t.test('every scan wrote an admits row', async () => {
    const scans = db.prepare('SELECT COUNT(*) AS n FROM admits').get().n;
    assert.ok(scans >= 11); // all scans above, ok and denied alike
  });
});

test('admissions: member pass validation', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());
  const c = client(base);
  await c('POST', '/api/auth/login', { username: 'gate', password: 'gate' });

  await t.test('active member -> ok with name and program, no use limit', async () => {
    mkMember(db, { pass: 'M-GOODMEMBR1', name: 'Mia Member' });
    for (let i = 0; i < 3; i++) {
      const r = await c('POST', '/api/admissions/scan', { code: 'M-GOODMEMBR1' });
      assert.equal(r.data.result, 'ok');
      assert.equal(r.data.kind, 'member');
      assert.equal(r.data.display_name, 'Mia Member');
      assert.match(r.data.detail, /Explorer Annual/);
    }
  });

  await t.test('lapsed member (expired yesterday) -> denied expired', async () => {
    mkMember(db, { pass: 'M-LAPSEDONE2', name: 'Lex Lapsed', expires: iso(Date.now() - DAY) });
    const r = await c('POST', '/api/admissions/scan', { code: 'M-LAPSEDONE2' });
    assert.equal(r.data.result, 'denied');
    assert.equal(r.data.kind, 'member');
    assert.equal(r.data.reason, 'expired');
    assert.match(r.data.detail, /renew at POS/i);
  });

  await t.test('suspended member -> denied suspended', async () => {
    mkMember(db, { pass: 'M-SUSPENDED3', name: 'Sue Spended', status: 'suspended' });
    const r = await c('POST', '/api/admissions/scan', { code: 'M-SUSPENDED3' });
    assert.equal(r.data.result, 'denied');
    assert.equal(r.data.reason, 'suspended');
  });

  await t.test('member denials also write admits rows', async () => {
    const rows = db.prepare(
      "SELECT result, reason FROM admits WHERE kind = 'member' ORDER BY id"
    ).all();
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.slice(3).map((r) => r.reason), ['expired', 'suspended']);
  });
});

test('admissions: auth, roles, and UI feeds', async (t) => {
  const { server, db, base } = await startServer();
  t.after(() => server.close());

  await t.test('scan requires sign-in', async () => {
    const anon = client(base);
    const r = await anon('POST', '/api/admissions/scan', { code: 'T-WHATEVER11' });
    assert.equal(r.status, 401);
  });

  await t.test('scan rejects empty code', async () => {
    const c = client(base);
    await c('POST', '/api/auth/login', { username: 'gate', password: 'gate' });
    const r = await c('POST', '/api/admissions/scan', { code: '   ' });
    assert.equal(r.status, 400);
  });

  await t.test('recent feed: today count only counts ok admits, list capped at 10', async () => {
    const c = client(base);
    await c('POST', '/api/auth/login', { username: 'gate', password: 'gate' });
    mkTicket(db, { code: 'T-COUNTME999', holder: 'Cora Count' });
    await c('POST', '/api/admissions/scan', { code: 'T-COUNTME999' }); // ok
    for (let i = 0; i < 11; i++) {
      await c('POST', '/api/admissions/scan', { code: `T-BADCODE${String(i).padStart(3, '0')}` });
    }
    const r = await c('GET', '/api/admissions/recent');
    assert.equal(r.status, 200);
    assert.equal(r.data.today_count, 1);
    assert.equal(r.data.recent.length, 10);
    assert.equal(r.data.recent[0].result, 'denied'); // newest first
  });

  await t.test('simulator is manager+ only and lists valid tickets/active members', async () => {
    const gateC = client(base);
    await gateC('POST', '/api/auth/login', { username: 'gate', password: 'gate' });
    const denied = await gateC('GET', '/api/admissions/simulator');
    assert.equal(denied.status, 403);

    mkTicket(db, { code: 'T-SIMLIST111', holder: 'Sid Sim' });
    mkTicket(db, { code: 'T-SIMVOID222', status: 'void' });
    mkMember(db, { pass: 'M-SIMACTIVE4', name: 'Ana Active' });
    mkMember(db, { pass: 'M-SIMDEAD555', name: 'Gus Gone', expires: iso(Date.now() - DAY) });

    const mgr = client(base);
    await mgr('POST', '/api/auth/login', { username: 'manager', password: 'manager' });
    const r = await mgr('GET', '/api/admissions/simulator');
    assert.equal(r.status, 200);
    const codes = r.data.tickets.map((x) => x.code);
    assert.ok(codes.includes('T-SIMLIST111'));
    assert.ok(!codes.includes('T-SIMVOID222'));
    const passes = r.data.members.map((x) => x.pass_code);
    assert.ok(passes.includes('M-SIMACTIVE4'));
    assert.ok(!passes.includes('M-SIMDEAD555'));

    // manager can scan too
    const scan = await mgr('POST', '/api/admissions/scan', { code: 'T-SIMLIST111', gate: 'west' });
    assert.equal(scan.data.result, 'ok');
    const row = db.prepare('SELECT * FROM admits ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.gate, 'west');
  });

  await t.test('checkCode export works without HTTP (module-level contract)', async () => {
    const { checkCode } = require('../server/modules/admissions');
    const r = checkCode(db, 't-simlist111', 'main'); // case-insensitive input
    assert.equal(r.kind, 'ticket');
    assert.equal(r.result, 'denied'); // already used in previous subtest
    assert.equal(r.reason, 'exhausted');
  });
});
