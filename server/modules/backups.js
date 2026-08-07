'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { ApiError } = require('../core/http');
const { audit } = require('../core/auth');
const { log, logError } = require('../core/log');

// Snapshots via the SQLite online backup API. The filesystem (ctx.backupDir,
// default data/backups/) is the source of truth for the snapshot catalog —
// deliberately not a DB table, because a catalog stored inside the database
// being restored would be stale after every restore. Restore is offline-only:
// tools/restore.js, with the server stopped.

// owlpark-<YYYYMMDDTHHMMSS>[-n]-<trigger>.db — the only names this module ever
// creates, deletes, or accepts from the API. Anything else in the dir is left alone.
const NAME_RE = /^owlpark-\d{8}T\d{6}(?:-\d+)?-(scheduled|manual)\.db$/;

const INTERVAL_DEFAULT_MIN = 60; // 0 = scheduler off
const RETAIN_DEFAULT = 14;

let running = false; // at most one backup in flight per process

// The snapshot inherits the source's WAL mode, so SQLite drops -shm/-wal
// sidecars beside the .tmp working file; they're stale the moment the .tmp is
// verified (or abandoned) and must be removed with it.
const TMP_RE = /\.tmp(?:-shm|-wal)?$/;

function rmTmp(tmpPath) {
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(tmpPath + suffix, { force: true });
}

// Config: settings row wins, then env, then default. Values are clamped, never
// trusted raw (a settings row is operator-editable data, not code).
function configInt(ctx, key, envName, fallback, min, max) {
  const row = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const raw = row ? row.value : (ctx.env || process.env)[envName];
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function intervalMin(ctx) {
  return configInt(ctx, 'backups.interval_min', 'OWLPOS_BACKUP_INTERVAL_MIN', INTERVAL_DEFAULT_MIN, 0, 1440);
}

function retainCount(ctx) {
  return configInt(ctx, 'backups.retain', 'OWLPOS_BACKUP_RETAIN', RETAIN_DEFAULT, 1, 365);
}

// Server-local timestamp (day boundaries are server-local throughout the suite).
function tsName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Resolve a snapshot name to a path inside backupDir, or null. Pattern check
// first, then containment (same pattern as serveStatic) — never pass a raw
// request param to fs.
function safeSnapshotPath(backupDir, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const file = path.normalize(path.join(backupDir, name));
  if (!file.startsWith(backupDir + path.sep)) return null;
  return file;
}

function listBackups(ctx) {
  if (!fs.existsSync(ctx.backupDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(ctx.backupDir)) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const st = fs.statSync(path.join(ctx.backupDir, name));
    out.push({ name, bytes: st.size, mtime: st.mtime.toISOString(), trigger: m[1] });
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

function lastBackupAt(ctx) {
  const newest = listBackups(ctx)[0];
  return newest ? newest.mtime : null;
}

// Delete snapshots beyond the retention count. Only files matching NAME_RE are
// candidates (a hand-placed keep-this.db — or the live DB, if backupDir is
// misconfigured to the data dir — is never touched), and the snapshot just
// written is always kept because retain is clamped to >= 1 and it sorts newest.
function prune(ctx, retain, userId) {
  const removed = [];
  for (const b of listBackups(ctx).slice(retain)) {
    fs.unlinkSync(path.join(ctx.backupDir, b.name));
    audit(ctx.db, userId, 'backups.prune', { file: b.name });
    removed.push(b.name);
  }
  if (removed.length) log('info', 'backup.pruned', { files: removed });
  return removed;
}

// The single backup path (manual button, scheduler, smoke). Writes to a .tmp
// name, verifies integrity, then renames — a crash leaves only .tmp litter
// (cleared on the next run), never a truncated .db under a final name.
async function runBackup(ctx, { trigger = 'manual', userId = null } = {}) {
  if (running) {
    throw new ApiError(409, 'backup_running', 'A backup is already running — try again in a moment');
  }
  running = true;
  const started = Date.now();
  try {
    fs.mkdirSync(ctx.backupDir, { recursive: true });
    for (const f of fs.readdirSync(ctx.backupDir)) {
      const m = TMP_RE.exec(f);
      if (m && NAME_RE.test(f.slice(0, m.index))) fs.unlinkSync(path.join(ctx.backupDir, f));
    }

    let name = `owlpark-${tsName()}-${trigger}.db`;
    for (let n = 1; fs.existsSync(path.join(ctx.backupDir, name)); n++) {
      name = `owlpark-${tsName()}-${n}-${trigger}.db`;
    }
    const finalPath = path.join(ctx.backupDir, name);
    const tmpPath = finalPath + '.tmp';

    // rate: 64 pages per step keeps the event loop responsive (gate scans keep
    // working); SQLite restarts the copy on source writes, so the snapshot is
    // always consistent.
    const pages = await sqlite.backup(ctx.db, tmpPath, { rate: 64 });
    try {
      const check = new sqlite.DatabaseSync(tmpPath, { readOnly: true });
      const row = check.prepare('PRAGMA integrity_check').get();
      check.close();
      if (row.integrity_check !== 'ok') throw new Error(`integrity_check: ${row.integrity_check}`);
    } catch (err) {
      rmTmp(tmpPath);
      throw err;
    }
    fs.chmodSync(tmpPath, 0o600); // full DB copy: scrypt hashes, member PII
    fs.renameSync(tmpPath, finalPath);
    rmTmp(tmpPath); // only the sidecars remain after the rename

    // Roadmap WAL policy: checkpoint + truncate after every snapshot so the
    // WAL never grows without bound.
    ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    prune(ctx, retainCount(ctx), userId);

    const bytes = fs.statSync(finalPath).size;
    const ms = Date.now() - started;
    audit(ctx.db, userId, 'backups.run', { file: name, bytes, ms, trigger });
    log('info', 'backup.done', { file: name, bytes, pages, ms, trigger });
    return { file: name, bytes, pages, ms };
  } finally {
    running = false;
  }
}

function mount(router, ctx) {
  const env = ctx.env || process.env;
  router.get('/api/backups', ['admin', 'manager'], () => ({
    backups: listBackups(ctx),
    retain: retainCount(ctx),
    interval_min: intervalMin(ctx),
  }));

  router.post('/api/backups/run', ['admin'], async (req) => {
    if (env.VERCEL) {
      throw new ApiError(400, 'ephemeral', 'Hosted demo databases are ephemeral — backups are disabled');
    }
    const result = await runBackup(ctx, { trigger: 'manual', userId: req.user.id });
    return { backup: result };
  });

  router.del('/api/backups/:name', ['admin'], (req) => {
    const file = safeSnapshotPath(ctx.backupDir, req.params.name);
    if (!file) throw new ApiError(400, 'bad_name', 'Not a snapshot name');
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', 'No such snapshot');
    fs.unlinkSync(file);
    audit(ctx.db, req.user.id, 'backups.prune', { file: req.params.name, manual: true });
    log('info', 'backup.deleted', { file: req.params.name });
    return { ok: true };
  });

  // Scheduler: unref'd so tests and the smoke runner exit cleanly; never on
  // serverless (each warm instance would back up its own throwaway /tmp DB).
  const interval = intervalMin(ctx);
  if (interval > 0 && !env.VERCEL) {
    setInterval(() => {
      runBackup(ctx, { trigger: 'scheduled' }).catch((err) => {
        if (err.code === 'backup_running') log('info', 'backup.skipped', { reason: err.code });
        else logError('backup.failed', err);
      });
    }, interval * 60_000).unref();
  }
}

module.exports = { mount, runBackup, listBackups, lastBackupAt };
