'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { createApp } = require('../server/main');
const backups = require('../server/modules/backups');
const { log } = require('../server/core/log');

const RESTORE = path.join(__dirname, '..', 'tools', 'restore.js');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

async function startServer(dbPath = tempDb()) {
  const { server, db, ctx } = createApp(dbPath);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, db, ctx, base, dbPath };
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

async function login(base, who) {
  const c = client(base);
  const r = await c('POST', '/api/auth/login', { username: who, password: who });
  assert.equal(r.status, 200, `${who} login`);
  return c;
}

// Sell one adult ticket and finalize — exercises the normal write path.
async function sellOne(cashier) {
  const sell = (await cashier('GET', '/api/catalog/sellable?channel=pos')).data.products;
  const adult = sell.find((p) => p.sku === 'ADULT');
  const order = (await cashier('POST', '/api/pos/orders', {
    lines: [{ product_id: adult.id, qty: 1 }],
  })).data.order;
  const fin = await cashier('POST', `/api/pos/orders/${order.id}/finalize`, {
    payments: [{ method: 'card_sim', amount_cents: order.total_cents }],
  });
  assert.equal(fin.status, 200, 'finalize sale');
  return order;
}

test('backups: snapshot, rotation, concurrency, restore, security', async (t) => {
  const { server, db, ctx, base, dbPath } = await startServer();
  t.after(() => server.close());
  const backupDir = ctx.backupDir;

  const admin = await login(base, 'admin');
  const manager = await login(base, 'manager');
  const cashier = await login(base, 'cashier');
  const gate = await login(base, 'gate');

  let firstSnap = null;

  await t.test('manual backup produces a valid 0600 snapshot', async () => {
    await sellOne(cashier);
    const r = await admin('POST', '/api/backups/run', {});
    assert.equal(r.status, 200);
    firstSnap = r.data.backup.file;
    assert.match(firstSnap, /^owlpark-\d{8}T\d{6}(?:-\d+)?-manual\.db$/);
    assert.ok(r.data.backup.bytes > 0 && r.data.backup.pages > 0);
    const file = path.join(backupDir, firstSnap);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'snapshot is 0600');
    const snap = new DatabaseSync(file, { readOnly: true });
    assert.equal(snap.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const srcOrders = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
    assert.equal(snap.prepare('SELECT COUNT(*) n FROM orders').get().n, srcOrders);
    snap.close();
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'backups.run'").all();
    assert.equal(audit.length, 1);
    const list = await admin('GET', '/api/backups');
    assert.equal(list.data.backups[0].name, firstSnap);
  });

  await t.test('snapshot stays consistent under concurrent writes', async () => {
    const pending = backups.runBackup(ctx, { trigger: 'manual' });
    await sellOne(cashier); // interleaves with the online backup
    const { file } = await pending;
    const snap = new DatabaseSync(path.join(backupDir, file), { readOnly: true });
    assert.equal(snap.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const paid = snap.prepare("SELECT COALESCE(SUM(total_cents),0) s FROM orders WHERE status='paid'").get().s;
    const pay = snap.prepare('SELECT COALESCE(SUM(amount_cents - change_cents),0) s FROM payments').get().s;
    assert.equal(pay, paid, 'snapshot is internally consistent');
    snap.close();
  });

  await t.test('no .tmp working files or WAL sidecars survive a run', async () => {
    // simulate a crash mid-backup: orphaned working file plus its sidecars
    for (const suffix of ['', '-shm', '-wal']) {
      fs.writeFileSync(path.join(backupDir, `owlpark-20200101T000000-manual.db.tmp${suffix}`), 'stale');
    }
    await backups.runBackup(ctx, { trigger: 'manual' });
    const leftovers = fs.readdirSync(backupDir).filter((n) => /\.tmp(?:-shm|-wal)?$/.test(n));
    assert.deepEqual(leftovers, [], 'backup dir holds only finished snapshots');
  });

  await t.test('second backup while one runs is 409', async () => {
    const first = backups.runBackup(ctx, { trigger: 'manual' });
    await assert.rejects(backups.runBackup(ctx, { trigger: 'manual' }), (err) => {
      assert.equal(err.code, 'backup_running');
      assert.equal(err.status, 409);
      return true;
    });
    await first;
  });

  await t.test('rotation keeps retain newest, spares decoys', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('backups.retain', '2')").run();
    fs.writeFileSync(path.join(backupDir, 'keep-this.db'), 'not a snapshot');
    // roll into a fresh second so a pruned name can't be re-minted for a new file
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 3; i++) {
      await backups.runBackup(ctx, { trigger: 'manual' });
      await new Promise((r) => setTimeout(r, 20)); // distinct mtimes
    }
    const names = fs.readdirSync(backupDir);
    const snaps = names.filter((n) => /^owlpark-.*\.db$/.test(n));
    assert.equal(snaps.length, 2, 'only retain snapshots remain');
    assert.ok(names.includes('keep-this.db'), 'decoy file untouched');
    assert.ok(!snaps.includes(firstSnap), 'oldest snapshot pruned');
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'backups.prune'").get().n >= 1);
    db.prepare("DELETE FROM settings WHERE key = 'backups.retain'").run();
  });

  await t.test('authz matrix on all three routes', async () => {
    const anon = client(base);
    const ghost = 'owlpark-20260101T000000-manual.db'; // valid shape, absent
    const cases = [
      ['GET', '/api/backups', { admin: 200, manager: 200, cashier: 403, gate: 403, anon: 401 }],
      ['POST', '/api/backups/run', { admin: 200, manager: 403, cashier: 403, gate: 403, anon: 401 }],
      ['DELETE', `/api/backups/${ghost}`, { admin: 404, manager: 403, cashier: 403, gate: 403, anon: 401 }],
    ];
    const who = { admin, manager, cashier, gate, anon };
    for (const [method, route, expected] of cases) {
      for (const [name, want] of Object.entries(expected)) {
        const body = method === 'GET' ? undefined : {};
        const r = await who[name](method, route, body);
        assert.equal(r.status, want, `${name} ${method} ${route}`);
        if (want === 401 || want === 403) {
          assert.ok(r.data.error && r.data.message, 'standard error shape');
        }
      }
    }
  });

  await t.test('health hides disk fields from anon/cashier/gate', async () => {
    const anonHealth = (await client(base)('GET', '/api/health')).data;
    assert.deepEqual(Object.keys(anonHealth).sort(), ['ephemeral', 'mode', 'ok']);
    for (const c of [cashier, gate]) {
      const h = (await c('GET', '/api/health')).data;
      assert.deepEqual(Object.keys(h).sort(), ['ephemeral', 'mode', 'ok']);
    }
    const mgr = (await manager('GET', '/api/health')).data;
    assert.ok(mgr.disk_free_bytes > 0 && mgr.db_bytes > 0);
    assert.equal(typeof mgr.disk_low, 'boolean');
    assert.ok(mgr.last_backup_at, 'manager sees last backup time');
  });

  await t.test('delete rejects traversal and junk names, DB survives', async () => {
    const bad = [
      '/api/backups/nope.db',
      '/api/backups/..%2f..%2ftest.db',
      '/api/backups/....%2f%2ftest.db',
      '/api/backups/owlpark-20260101T000000-manual.db%00.txt',
      '/api/backups/../test.db',
    ];
    for (const p of bad) {
      const r = await admin('DELETE', p, {});
      assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`);
      assert.ok(!JSON.stringify(r.data).includes(backupDir), 'no path leakage');
    }
    assert.ok(fs.existsSync(dbPath), 'live DB untouched');
    const del = await admin('DELETE', `/api/backups/${firstSnap}`, {});
    assert.equal(del.status, 404, 'already-pruned snapshot is 404');
  });

  await t.test('static server never serves the backup dir', async () => {
    const name = (await admin('GET', '/api/backups')).data.backups[0].name;
    const res = await fetch(`${base}/backups/${name}`);
    assert.equal(res.status, 404);
  });
});

test('backups: structured logs are injection-safe JSON lines', async () => {
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return orig.call(process.stdout, chunk, ...rest);
  };
  try {
    log('info', 'test.event', { name: 'evil\n{"level":"info","event":"forged"}' });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(lines.length, 1, 'one record, one line');
  const parsed = JSON.parse(lines[0].trim());
  assert.equal(parsed.event, 'test.event');
  assert.ok(parsed.ts && parsed.level === 'info');
  assert.ok(parsed.name.includes('forged'), 'payload survives as data, not as a record');
});

test('backups: backup.done log line is structured', async () => {
  const { server, ctx } = await startServer();
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return orig.call(process.stdout, chunk, ...rest);
  };
  try {
    await backups.runBackup(ctx, { trigger: 'manual' });
  } finally {
    process.stdout.write = orig;
    server.close();
  }
  const done = lines.map((l) => { try { return JSON.parse(l.trim()); } catch { return null; } })
    .find((l) => l && l.event === 'backup.done');
  assert.ok(done, 'backup.done emitted');
  assert.ok(done.ts && done.level === 'info' && done.file && done.bytes > 0);
});

test('backups: disabled on ephemeral hosting, interval 0 turns scheduler off', async (t) => {
  process.env.VERCEL = '1';
  t.after(() => { delete process.env.VERCEL; delete process.env.OWLPOS_BACKUP_INTERVAL_MIN; });
  const { server, base, ctx } = await startServer();
  t.after(() => server.close());
  const admin = await login(base, 'admin');
  const r = await admin('POST', '/api/backups/run', {});
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'ephemeral');
  assert.equal(fs.existsSync(ctx.backupDir), false, 'no backup dir was created');
  delete process.env.VERCEL;

  process.env.OWLPOS_BACKUP_INTERVAL_MIN = '0';
  const app2 = await startServer();
  t.after(() => app2.server.close());
  const admin2 = await login(app2.base, 'admin');
  const cfg = await admin2('GET', '/api/backups');
  assert.equal(cfg.data.interval_min, 0, 'scheduler config off');
});

test('backups: restore round-trip and newer-schema refusal', async (t) => {
  const { server, db, ctx, base, dbPath } = await startServer();
  const admin = await login(base, 'admin');
  const cashier = await login(base, 'cashier');
  await sellOne(cashier);
  const snapName = (await admin('POST', '/api/backups/run', {})).data.backup.file;
  const snapPath = path.join(ctx.backupDir, snapName);
  const ordersAtSnap = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
  await sellOne(cashier); // post-snapshot write that the restore must roll back
  await new Promise((resolve) => server.close(resolve));
  db.close();

  await t.test('restore replaces the DB and preserves the old one', () => {
    execFileSync(process.execPath, [RESTORE, snapPath, '--db', dbPath, '--force']);
    const dir = fs.readdirSync(path.dirname(dbPath));
    assert.ok(dir.some((f) => f.includes('-pre-restore-')), 'pre-restore copy kept');
    const app2 = createApp(dbPath); // migrate re-runs as a no-op, no reseed
    assert.equal(app2.db.prepare('SELECT COUNT(*) n FROM orders').get().n, ordersAtSnap);
    assert.equal(app2.db.prepare('SELECT COUNT(*) n FROM users').get().n, 4, 'seed did not re-run');
    const rec = app2.db.prepare("SELECT detail FROM audit_log WHERE action = 'backups.restore'").get();
    assert.ok(rec && JSON.parse(rec.detail).file === snapName, 'restore audited');
    app2.db.close();
  });

  await t.test('restore refuses a snapshot from newer code', () => {
    const snap = new DatabaseSync(snapPath);
    snap.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
      .run('999_future.sql', new Date().toISOString());
    snap.close();
    const before = fs.statSync(dbPath).mtimeMs;
    assert.throws(() => execFileSync(process.execPath, [RESTORE, snapPath, '--db', dbPath, '--force'],
      { stdio: 'pipe' }));
    assert.equal(fs.statSync(dbPath).mtimeMs, before, 'target untouched');
  });

  await t.test('restore refuses .tmp files', () => {
    const tmp = snapPath + '.tmp';
    fs.copyFileSync(snapPath, tmp);
    assert.throws(() => execFileSync(process.execPath, [RESTORE, tmp, '--db', dbPath, '--force'],
      { stdio: 'pipe' }));
  });
});

test('backups: restore live-server and failure-atomicity guards', async (t) => {
  // Build a DB + one real snapshot, all cleanly closed.
  const { server, db, ctx, base, dbPath } = await startServer();
  const admin = await login(base, 'admin');
  const cashier = await login(base, 'cashier');
  await sellOne(cashier);
  const snapName = (await admin('POST', '/api/backups/run', {})).data.backup.file;
  const snapPath = path.join(ctx.backupDir, snapName);
  const usersBefore = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  const dataDir = path.dirname(dbPath);

  await t.test('refuses while another process still holds the database open', () => {
    // The real hazard is a live server, and it is detected by probing for
    // exclusive access — not by looking for sidecar files. This connection is
    // idle with no transaction in flight, exactly like a server between sales.
    const live = new DatabaseSync(dbPath);
    live.exec('PRAGMA journal_mode = WAL');
    const before = fs.statSync(dbPath).mtimeMs;
    try {
      assert.throws(
        () => execFileSync(process.execPath, [RESTORE, snapPath, '--db', dbPath], { stdio: 'pipe' }),
        /still open by another process/i
      );
      assert.equal(fs.statSync(dbPath).mtimeMs, before, 'target untouched');
      assert.ok(!fs.readdirSync(dataDir).some((f) => f.includes('-pre-restore-')),
        'nothing was moved aside');
    } finally {
      live.close();
    }
  });

  await t.test('runs without --force after a stop that left sidecars behind', () => {
    // A killed server leaves -wal/-shm with nothing alive. The documented
    // runbook has to work here: a guard that always fires would just train
    // operators to pass --force, which is the flag that disables the guard.
    fs.writeFileSync(dbPath + '-wal', '');
    fs.writeFileSync(dbPath + '-shm', '');
    const out = execFileSync(process.execPath, [RESTORE, snapPath, '--db', dbPath],
      { stdio: 'pipe', encoding: 'utf8' });
    const res = JSON.parse(out);
    assert.ok(res.ok);
    assert.ok(!fs.existsSync(dbPath + '-wal') && !fs.existsSync(dbPath + '-shm'),
      'stale sidecars are gone, never replayable over the restored file');
    // the preserved copy is a whole database too — same secrets, same 0600
    assert.equal(fs.statSync(res.pre_restore).mode & 0o777, 0o600, 'pre-restore copy is private');
    assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600, 'restored database is private');
  });

  await t.test('refuses to restore the target onto itself', () => {
    const before = fs.statSync(dbPath).mtimeMs;
    assert.throws(
      () => execFileSync(process.execPath, [RESTORE, dbPath, '--db', dbPath, '--force'],
        { stdio: 'pipe' }),
      /same file/
    );
    assert.ok(fs.existsSync(dbPath), 'live DB still in place');
    assert.equal(fs.statSync(dbPath).mtimeMs, before, 'target untouched');
  });

  await t.test('rolls back when the restore fails after moving the live DB aside', () => {
    // A "snapshot" that passes every upstream check (integrity, known
    // migrations, name pattern) but blows up the post-rename phase: the
    // restore's own audit insert finds no audit_log table.
    const bogusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-bogus-'));
    const bogusPath = path.join(bogusDir, 'owlpark-20260101T000000-manual.db');
    const bogus = new DatabaseSync(bogusPath);
    bogus.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT)');
    bogus.close();

    // the previous subtests' read-only integrity probe leaves WAL sidecars it
    // cannot delete, and the --force restore left a pre-restore copy — clear
    // both so this models a cleanly-stopped server in a tidy data dir
    for (const ext of ['-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true });
    for (const f of fs.readdirSync(dataDir)) {
      if (f.includes('-pre-restore-')) fs.rmSync(path.join(dataDir, f), { force: true });
    }
    const pre = fs.readdirSync(dataDir);
    assert.throws(
      () => execFileSync(process.execPath, [RESTORE, bogusPath, '--db', dbPath], { stdio: 'pipe' }),
      /left in place/
    );
    // original DB is back at dbPath with its real contents, no litter left over
    const app = createApp(dbPath);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM users').get().n, usersBefore);
    app.db.close();
    assert.deepEqual(fs.readdirSync(dataDir).sort(), pre.sort(),
      'no staging/pre-restore litter after rollback');
  });
});

test('backups: the documented runbook — stop the real server, then restore', async () => {
  // End to end, exactly as docs/user-guide.md tells an operator to do it: no
  // --force anywhere. A guard that fires after every ordinary stop would make
  // --force a habit, and --force is the thing that disables the guard.
  const { server, db, ctx, base, dbPath } = await startServer();
  const admin = await login(base, 'admin');
  const cashier = await login(base, 'cashier');
  await sellOne(cashier);
  const snapName = (await admin('POST', '/api/backups/run', {})).data.backup.file;
  const snapPath = path.join(ctx.backupDir, snapName);
  await new Promise((resolve) => server.close(resolve));
  db.close();

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'main.js')], {
    // port 0 → ephemeral; these tests never bind 4650
    env: { ...process.env, OWLPOS_DB: dbPath, OWLPOS_PORT: '0', OWLPOS_BACKUP_DIR: ctx.backupDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('server.listen')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code})\n${out}`)));
  });
  assert.ok(fs.existsSync(dbPath + '-wal'), 'a running server holds a WAL');

  child.kill('SIGTERM'); // what Ctrl-C and `systemctl stop` both send
  assert.equal(await exited, 0, 'the server exits cleanly on SIGTERM');
  assert.ok(!fs.existsSync(dbPath + '-wal') && !fs.existsSync(dbPath + '-shm'),
    'a stopped server leaves no sidecars behind');

  const out = execFileSync(process.execPath, [RESTORE, snapPath, '--db', dbPath],
    { stdio: 'pipe', encoding: 'utf8' });
  assert.ok(JSON.parse(out).ok, 'the runbook completes without --force');
});

test('backups: snapshot DELETE works with an unnormalized OWLPOS_BACKUP_DIR', async (t) => {
  const dbPath = tempDb();
  // trailing slash — the common env-file spelling that used to 400 every DELETE
  const backupDir = path.join(path.dirname(dbPath), 'backups') + path.sep;
  const { server, db } = createApp(dbPath, {
    env: { OWLPOS_BACKUP_DIR: backupDir, OWLPOS_BACKUP_INTERVAL_MIN: '0' },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = await login(base, 'admin');
  const snapName = (await admin('POST', '/api/backups/run', {})).data.backup.file;
  assert.ok(fs.existsSync(path.join(backupDir, snapName)));

  const del = await admin('DELETE', `/api/backups/${snapName}`);
  assert.equal(del.status, 200, `DELETE must accept a valid snapshot (got ${del.status})`);
  assert.ok(!fs.existsSync(path.join(backupDir, snapName)), 'snapshot removed');
});
