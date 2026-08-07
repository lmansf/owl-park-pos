'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// WAL allows exactly one writer at a time across processes. With SQLite's
// default busy timeout of 0 any collision — a cashier tendering while an
// operator runs tools/users.js — throws SQLITE_BUSY instantly and BOTH sides
// fail hard (a 500 mid-sale, a half-applied CLI run). Waiting a few seconds
// costs nothing and makes those collisions invisible.
const BUSY_TIMEOUT_MS = 5000;

// The database holds scrypt password hashes, member PII, and plaintext ticket /
// member pass codes — bearer credentials that admissions.checkCode admits on
// with no login at all. Every copy of it is 0600 (backups.js, restore.js); the
// live file and its sidecars must not be the one world-readable artifact.
const DB_FILE_MODE = 0o600;

// opts.mustExist refuses to create a database that was supposed to be there
// already: an unmounted data volume must fail closed, not quietly seed a fresh
// demo park that staff then sell a whole day against.
function openDb(dbPath, opts = {}) {
  if (opts.mustExist && !fs.existsSync(dbPath)) {
    throw new Error(
      `database not found: ${dbPath} — refusing to create and seed a new one in ` +
      'production mode. Check OWLPOS_DB and that the data volume is mounted; set ' +
      'OWLPOS_INIT_DB=1 to create a fresh database on purpose.'
    );
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  // Tighten the main file BEFORE journal_mode=WAL: SQLite creates -wal/-shm
  // with the main database's permissions, so this makes the sidecars private
  // too. The second pass covers sidecars left behind by an older, laxer run.
  restrictDbMode(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  restrictDbMode(dbPath);
  return db;
}

// Best-effort: a database owned by another user (or on a filesystem without
// POSIX modes) must not stop the venue from opening for the day.
function restrictDbMode(dbPath) {
  for (const ext of ['', '-wal', '-shm']) {
    const file = dbPath + ext;
    try {
      if ((fs.statSync(file).mode & 0o777) !== DB_FILE_MODE) fs.chmodSync(file, DB_FILE_MODE);
    } catch { /* missing, foreign-owned, or modeless filesystem — keep serving */ }
  }
}

// The clean-shutdown counterpart to openDb. SQLite deletes the -wal/-shm
// sidecars only when the LAST connection closes cleanly; a process that just
// dies leaves the whole database stranded in the WAL and looking "open" to
// tools/restore.js forever. Checkpointing first folds the WAL back into the
// database file so what remains on disk is complete on its own.
function closeDb(db) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* closing anyway */ }
  try { db.close(); } catch { /* already closed */ }
}

function migrate(db, migrationsDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Table rebuilds (the only way SQLite can change a CHECK constraint) follow
    // the official ALTER TABLE procedure, which requires foreign_keys=OFF for
    // the duration — that pragma is a no-op inside a transaction, so a
    // migration opts in via this directive and we compensate with an explicit
    // foreign_key_check before COMMIT.
    const fkOff = /^--\s*migrate:\s*foreign_keys=off\s*$/m.test(sql);
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      if (fkOff) {
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length) {
          throw new Error(`foreign_key_check found ${bad.length} violation(s)`);
        }
      }
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

// Run fn inside a transaction; nested calls join the outer transaction.
function tx(db, fn) {
  if (db.__inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.__inTx = true;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.__inTx = false;
  }
}

function now() {
  return new Date().toISOString();
}

module.exports = { openDb, closeDb, migrate, tx, now, BUSY_TIMEOUT_MS, DB_FILE_MODE };
