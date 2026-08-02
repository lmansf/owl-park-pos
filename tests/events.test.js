'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const { tx } = require('../server/core/db');
const eventsMod = require('../server/modules/events');

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

test('events: management API, availability, capacity guard', async (t) => {
  const { server, db, ctx, base } = await startServer();
  t.after(() => server.close());

  const mgr = client(base);
  await mgr('POST', '/api/auth/login', { username: 'manager', password: 'manager' });

  let eventId;
  let sessions;

  await t.test('anonymous GET /api/events is 401; signed-in is 200', async () => {
    const anon = await fetch(base + '/api/events');
    assert.equal(anon.status, 401);
    const r = await mgr('GET', '/api/events');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.events));
    assert.ok(r.data.events.some((e) => e.name === 'Planetarium Show'));
  });

  await t.test('create event', async () => {
    const r = await mgr('POST', '/api/events', { name: 'Laser Dome', description: 'test event' });
    assert.equal(r.status, 200);
    eventId = r.data.event.id;
    assert.ok(eventId > 0);
    const bad = await mgr('POST', '/api/events', { name: '   ' });
    assert.equal(bad.status, 400);
  });

  await t.test('bulk generate: 14 days, 10:00-17:30 every 90 min, capacity 40 => 84 x 0/40', async () => {
    const r = await mgr('POST', `/api/events/${eventId}/sessions/generate`, {
      start_date: '2027-03-01', end_date: '2027-03-14',
      start_time: '10:00', end_time: '17:30',
      interval_minutes: 90, capacity: 40, duration_minutes: 45,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.created, 84); // 6 slots/day * 14 days
    assert.equal(r.data.skipped, 0);

    const g = await mgr('GET', `/api/events/${eventId}/sessions?from=2027-03-01&to=2027-03-14`);
    assert.equal(g.status, 200);
    sessions = g.data.sessions;
    assert.equal(sessions.length, 84);
    for (const s of sessions) {
      assert.equal(s.sold, 0);
      assert.equal(s.capacity, 40);
      assert.equal(s.remaining, 40);
      assert.equal(s.sold_out, false);
      assert.equal(s.event_id, eventId);
      assert.ok(s.starts_at < s.ends_at);
    }
  });

  await t.test('re-generate skips existing slots', async () => {
    const r = await mgr('POST', `/api/events/${eventId}/sessions/generate`, {
      start_date: '2027-03-01', end_date: '2027-03-01',
      start_time: '10:00', end_time: '17:30',
      interval_minutes: 90, capacity: 40,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.created, 0);
    assert.equal(r.data.skipped, 6);
  });

  await t.test('generate rejects bad input', async () => {
    const bad = await mgr('POST', `/api/events/${eventId}/sessions/generate`, {
      start_date: '2027-03-14', end_date: '2027-03-01',
      start_time: '10:00', end_time: '17:30', interval_minutes: 90, capacity: 40,
    });
    assert.equal(bad.status, 400);
    const bad2 = await mgr('POST', `/api/events/${eventId}/sessions/generate`, {
      start_date: '2027-04-01', end_date: '2027-04-01',
      start_time: '10:00', end_time: '17:30', interval_minutes: 0, capacity: 40,
    });
    assert.equal(bad2.status, 400);
  });

  await t.test('availability API is public and filters by from/to', async () => {
    const res = await fetch(base + `/api/events/${eventId}/sessions?from=2027-03-02&to=2027-03-02`);
    assert.equal(res.status, 200); // no cookie: public route
    const { sessions: day } = await res.json();
    assert.equal(day.length, 6);
    // date-only filters mean LOCAL days (matching how sessions are generated)
    const localDay = (iso) => {
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    for (const s of day) assert.equal(localDay(s.starts_at), '2027-03-02');
    const missing = await fetch(base + '/api/events/999999/sessions');
    assert.equal(missing.status, 404);
  });

  await t.test('race at the last seat: second reserve throws, no partial state', () => {
    const sid = sessions[0].id;
    // shrink to capacity 1 so one seat remains
    tx(db, () => db.prepare('UPDATE event_sessions SET capacity = 1 WHERE id = ?').run(sid));
    tx(db, () => eventsMod.reserveCapacity(db, sid, 1)); // first order wins
    assert.equal(eventsMod.getSession(db, sid).sold, 1);

    assert.throws(
      () => tx(db, () => eventsMod.reserveCapacity(db, sid, 1)),
      (err) => err.status === 409 && err.code === 'capacity'
    );
    assert.equal(eventsMod.getSession(db, sid).sold, 1); // no increment from the loser
  });

  await t.test('sold-out session is flagged and rejected for further reserves', async () => {
    const sid = sessions[0].id; // capacity 1, sold 1 from previous test
    const res = await fetch(base + `/api/events/${eventId}/sessions?from=2027-03-01&to=2027-03-01`);
    const { sessions: day } = await res.json();
    const s = day.find((x) => x.id === sid);
    assert.equal(s.sold_out, true);
    assert.equal(s.remaining, 0);
    assert.throws(
      () => tx(db, () => eventsMod.reserveCapacity(db, sid, 1)),
      (err) => err.status === 409 && err.code === 'capacity'
    );
  });

  await t.test('failed outer tx rolls back the reserve (no partial state)', () => {
    const sid = sessions[1].id;
    assert.throws(() =>
      tx(db, () => {
        eventsMod.reserveCapacity(db, sid, 5);
        assert.equal(eventsMod.getSession(db, sid).sold, 5); // visible inside tx
        throw new Error('payment failed');
      })
    );
    assert.equal(eventsMod.getSession(db, sid).sold, 0); // rolled back
  });

  await t.test('reserve on cancelled session throws capacity', () => {
    const sid = sessions[2].id;
    tx(db, () => db.prepare('UPDATE event_sessions SET cancelled = 1 WHERE id = ?').run(sid));
    assert.throws(
      () => tx(db, () => eventsMod.reserveCapacity(db, sid, 1)),
      (err) => err.status === 409 && err.code === 'capacity'
    );
    tx(db, () => db.prepare('UPDATE event_sessions SET cancelled = 0 WHERE id = ?').run(sid));
  });

  await t.test('releaseCapacity decrements and clamps at zero', () => {
    const sid = sessions[3].id;
    tx(db, () => eventsMod.reserveCapacity(db, sid, 3));
    tx(db, () => eventsMod.releaseCapacity(db, sid, 2));
    assert.equal(eventsMod.getSession(db, sid).sold, 1);
    tx(db, () => eventsMod.releaseCapacity(db, sid, 10));
    assert.equal(eventsMod.getSession(db, sid).sold, 0);
    assert.throws(() => eventsMod.releaseCapacity(db, sid, 0), (e) => e.status === 400);
    assert.throws(() => eventsMod.reserveCapacity(db, sid, -1), (e) => e.status === 400);
  });

  await t.test('capacity edit: reject below sold, allow at/above sold', async () => {
    const sid = sessions[4].id;
    tx(db, () => eventsMod.reserveCapacity(db, sid, 12));
    const shrink = await mgr('PUT', `/api/events/sessions/${sid}`, { capacity: 10 });
    assert.equal(shrink.status, 409);
    assert.equal(shrink.data.error, 'capacity_below_sold');
    assert.equal(eventsMod.getSession(db, sid).capacity, 40); // unchanged

    const exact = await mgr('PUT', `/api/events/sessions/${sid}`, { capacity: 12 });
    assert.equal(exact.status, 200);
    assert.equal(exact.data.session.capacity, 12);
    assert.equal(exact.data.session.sold_out, true);

    const grow = await mgr('PUT', `/api/events/sessions/${sid}`, { capacity: 50 });
    assert.equal(grow.status, 200);
    assert.equal(grow.data.session.remaining, 38);

    const bad = await mgr('PUT', `/api/events/sessions/${sid}`, { capacity: 0 });
    assert.equal(bad.status, 400);
  });

  await t.test('cancel session with no sales: ok, disappears from availability', async () => {
    const sid = sessions[5].id;
    const r = await mgr('POST', `/api/events/sessions/${sid}/cancel`, {});
    assert.equal(r.status, 200);
    assert.equal(r.data.voided_tickets, 0);
    const res = await fetch(base + `/api/events/${eventId}/sessions?from=2027-03-01&to=2027-03-14`);
    const { sessions: after } = await res.json();
    assert.ok(!after.some((s) => s.id === sid));
    const again = await mgr('POST', `/api/events/sessions/${sid}/cancel`, {});
    assert.equal(again.status, 409);
  });

  await t.test('cancel session with sales: needs pos module to void tickets', async () => {
    const sid = sessions[6].id;
    tx(db, () => eventsMod.reserveCapacity(db, sid, 2));
    const r = await mgr('POST', `/api/events/sessions/${sid}/cancel`, {});
    if (ctx.modules.pos) {
      // integrated build: cancel succeeds and voids any valid tickets for the session
      assert.equal(r.status, 200);
      const left = db.prepare(
        "SELECT COUNT(*) AS n FROM tickets WHERE event_session_id = ? AND status = 'valid'"
      ).get(sid).n;
      assert.equal(left, 0);
    } else {
      // events-only build: reject with a clear error, session stays live
      assert.equal(r.status, 409);
      assert.equal(r.data.error, 'pos_required');
      assert.equal(eventsMod.getSession(db, sid).cancelled, 0);
    }
  });

  await t.test('role gates: cashier cannot manage, gate can list', async () => {
    const cashier = client(base);
    await cashier('POST', '/api/auth/login', { username: 'cashier', password: 'cashier' });
    assert.equal((await cashier('GET', '/api/events')).status, 200);
    assert.equal((await cashier('POST', '/api/events', { name: 'X' })).status, 403);
    assert.equal(
      (await cashier('PUT', `/api/events/sessions/${sessions[7].id}`, { capacity: 99 })).status,
      403
    );
    assert.equal(
      (await cashier('POST', `/api/events/sessions/${sessions[7].id}/cancel`, {})).status,
      403
    );
    assert.equal(
      (await cashier('POST', `/api/events/${eventId}/sessions/generate`, {})).status,
      403
    );

    const gate = client(base);
    await gate('POST', '/api/auth/login', { username: 'gate', password: 'gate' });
    assert.equal((await gate('GET', '/api/events')).status, 200);
  });

  await t.test('event update: rename + deactivate', async () => {
    const r = await mgr('PUT', `/api/events/${eventId}`, { name: 'Laser Dome II', active: false });
    assert.equal(r.status, 200);
    assert.equal(r.data.event.name, 'Laser Dome II');
    assert.equal(r.data.event.active, 0);
    const missing = await mgr('PUT', '/api/events/999999', { name: 'Nope' });
    assert.equal(missing.status, 404);
  });
});
