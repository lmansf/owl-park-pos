'use strict';
// Offline restore: node tools/restore.js <backup-file> [--db <path>] [--force]
// STOP THE SERVER FIRST — the tool probes whether anything still holds the
// database open and refuses if so. Verifies the snapshot (integrity + schema no
// newer than this checkout), preserves the current DB as
// owlpark-…-pre-restore-<ts>.db, then copies the snapshot into place. Every
// database file it leaves behind is mode 0600. Exits non-zero on any failure.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const NAME_RE = /^owlpark-\d{8}T\d{6}(?:-\d+)?-(scheduled|manual)\.db$/;
const PROBE_TIMEOUT_MS = 2000; // ride out a momentary lock before calling it live
const DB_FILE_MODE = 0o600;    // scrypt hashes, member PII, plaintext gate codes

function fail(msg) {
  console.error(`restore: ${msg}`);
  process.exit(1);
}

function tsName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// True when another process still has the database open. Taking a WAL database
// out of WAL mode requires exclusive access, so SQLITE_BUSY here is proof of a
// live connection — unlike the -wal/-shm files, which a killed server leaves
// behind forever (the server now closes cleanly, but crashes still happen).
// When nothing holds it, the same statement checkpoints the WAL back into the
// database, so the copy we are about to preserve is complete on its own.
// Any other error (a corrupt or read-only file — the very reason to restore)
// is not evidence of a live server and must not block recovery.
function inUse(dbPath) {
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA busy_timeout = ${PROBE_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = DELETE');
    return false;
  } catch (err) {
    if (err.errcode === 5 || err.errcode === 6 || /database is locked/i.test(err.message)) {
      return true;
    }
    console.error(`restore: could not probe ${path.basename(dbPath)} (${err.message}) — continuing`);
    return false;
  } finally {
    try { db?.close(); } catch { /* never opened, or already gone */ }
  }
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

  // Restoring the target onto itself can only destroy it — refuse outright.
  if (fs.existsSync(dbPath) && path.resolve(snapshot) === path.resolve(dbPath)) {
    fail('snapshot and target are the same file — nothing to restore');
  }

  // Live-server refusal, measured rather than guessed. Sidecar files are NOT
  // evidence: a stopped server can leave them behind. inUse() asks SQLite
  // itself whether anything still holds the database open.
  if (fs.existsSync(dbPath) && inUse(dbPath)) {
    const name = path.basename(dbPath);
    if (!force) {
      fail(`${name} is still open by another process — the server is running. STOP THE SERVER ` +
        'FIRST (Ctrl-C, or systemctl stop; it closes the database cleanly), then run this again. ' +
        'Pass --force only if you are certain nothing has this database open');
    }
    console.error(`restore: WARNING — ${name} is still open by another process; if that is the ` +
      'server it will keep writing to the pre-restore copy and every transaction after this ' +
      'restore will be LOST on its next restart. Continuing because of --force.');
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Failure-atomic: stage the full copy beside the target FIRST, so a copy
  // failure (ENOSPC, EACCES) exits here with the live DB untouched. Everything
  // after this point is same-directory renames, rolled back as a unit on error.
  const staging = dbPath + '.restore-staging';
  fs.rmSync(staging, { force: true });
  try {
    fs.copyFileSync(snapshot, staging);
    fs.chmodSync(staging, DB_FILE_MODE);
  } catch (err) {
    fs.rmSync(staging, { force: true });
    fail(`could not stage the snapshot copy (${err.message}) — database untouched`);
  }

  // Preserve the current DB (and its sidecars, so a stale WAL can never be
  // replayed over the restored file), then rename the staged copy into place.
  let preRestore = null;
  const renamed = []; // [from, to] pairs, for rollback
  let placed = false;
  try {
    if (fs.existsSync(dbPath)) {
      // never clobber an earlier preserved copy (two restores in one second)
      const stem = dbPath.replace(/\.db$/, '') + `-pre-restore-${tsName()}`;
      preRestore = `${stem}.db`;
      for (let n = 1; fs.existsSync(preRestore); n++) preRestore = `${stem}-${n}.db`;
      fs.renameSync(dbPath, preRestore);
      renamed.push([dbPath, preRestore]);
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(dbPath + ext)) {
          fs.renameSync(dbPath + ext, preRestore + ext);
          renamed.push([dbPath + ext, preRestore + ext]);
        }
      }
      // The preserved copy is a full database too — same secrets, same 0600 as
      // every snapshot; a restore must not leave a world-readable one behind.
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.chmodSync(preRestore + ext, DB_FILE_MODE); } catch { /* not present */ }
      }
    }
    fs.renameSync(staging, dbPath);
    placed = true;

    // Record the restore in the restored DB's own audit trail.
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA busy_timeout = ${PROBE_TIMEOUT_MS}`);
    try {
      db.prepare('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, NULL, ?, ?)')
        .run(new Date().toISOString(), 'backups.restore',
          JSON.stringify({ file: path.basename(snapshot), pre_restore: preRestore && path.basename(preRestore) }));
    } finally {
      db.close();
    }
  } catch (err) {
    // Put everything back exactly as it was, then exit non-zero.
    if (placed) for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true });
    for (const [from, to] of renamed.reverse()) {
      try { fs.renameSync(to, from); } catch { /* keep rolling the rest back */ }
    }
    fs.rmSync(staging, { force: true });
    fail(`restore failed (${err.message}) — the original database was left in place`);
  }

  console.log(JSON.stringify({
    ok: true,
    restored: path.basename(snapshot),
    db: dbPath,
    pre_restore: preRestore,
    note: 'older snapshots are fine — pending migrations apply on next server start',
  }, null, 2));
}

main();
