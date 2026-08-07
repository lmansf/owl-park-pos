'use strict';
// Offline restore: node tools/restore.js <backup-file> [--db <path>] [--force]
// STOP THE SERVER FIRST. Verifies the snapshot (integrity + schema no newer than
// this checkout), preserves the current DB as owlpark-…-pre-restore-<ts>.db, then
// copies the snapshot into place. Exits non-zero on any failure.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const NAME_RE = /^owlpark-\d{8}T\d{6}(?:-\d+)?-(scheduled|manual)\.db$/;

function fail(msg) {
  console.error(`restore: ${msg}`);
  process.exit(1);
}

function tsName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dbFlag = args.indexOf('--db');
  const dbPath = dbFlag >= 0
    ? args[dbFlag + 1]
    : process.env.OWLPOS_DB || path.join(ROOT, 'data', 'owlpark-pos.db');
  const snapshot = args.filter((a, i) => !a.startsWith('--') && (dbFlag < 0 || i !== dbFlag + 1))[0];

  if (!snapshot || !dbPath) {
    fail('usage: node tools/restore.js <backup-file> [--db <path>] [--force]');
  }
  if (!fs.existsSync(snapshot)) fail(`snapshot not found: ${snapshot}`);
  if (snapshot.endsWith('.tmp')) fail('refusing a .tmp file — that backup never completed');
  if (!NAME_RE.test(path.basename(snapshot)) && !force) {
    fail(`${path.basename(snapshot)} does not look like a snapshot (use --force to override)`);
  }

  // Verify the snapshot before touching anything.
  const snap = new DatabaseSync(snapshot, { readOnly: true });
  const integrity = snap.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') { snap.close(); fail(`snapshot fails integrity_check: ${integrity}`); }
  const snapMigrations = snap.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name);
  snap.close();
  const known = new Set(
    fs.readdirSync(path.join(ROOT, 'server', 'migrations')).filter((f) => f.endsWith('.sql'))
  );
  const unknown = snapMigrations.filter((n) => !known.has(n));
  if (unknown.length) {
    fail(`snapshot schema is newer than this checkout (unknown migrations: ${unknown.join(', ')}) — update the code first`);
  }

  // A recently-written WAL means the server is probably still running.
  const wal = dbPath + '-wal';
  if (fs.existsSync(wal) && Date.now() - fs.statSync(wal).mtimeMs < 10_000) {
    if (!force) fail('the database WAL was written seconds ago — stop the server first (or pass --force)');
    console.error('restore: WARNING — WAL is fresh; continuing because of --force');
  }

  // Preserve the current DB (and its sidecars, so a stale WAL can never be
  // replayed over the restored file).
  let preRestore = null;
  if (fs.existsSync(dbPath)) {
    preRestore = dbPath.replace(/\.db$/, '') + `-pre-restore-${tsName()}.db`;
    fs.renameSync(dbPath, preRestore);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, preRestore + ext);
    }
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(snapshot, dbPath);
  fs.chmodSync(dbPath, 0o600);

  // Record the restore in the restored DB's own audit trail.
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, NULL, ?, ?)')
    .run(new Date().toISOString(), 'backups.restore',
      JSON.stringify({ file: path.basename(snapshot), pre_restore: preRestore && path.basename(preRestore) }));
  db.close();

  console.log(JSON.stringify({
    ok: true,
    restored: path.basename(snapshot),
    db: dbPath,
    pre_restore: preRestore,
    note: 'older snapshots are fine — pending migrations apply on next server start',
  }, null, 2));
}

main();
