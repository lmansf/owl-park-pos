'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
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

module.exports = { openDb, migrate, tx, now };
