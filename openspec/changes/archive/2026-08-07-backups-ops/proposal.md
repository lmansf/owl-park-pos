# Change: backups-ops — scheduled backups, tested restore, ops visibility

## Why

One SQLite file is the whole business; today its only durability story is "don't lose
the disk". The production roadmap (§3, data durability and operations) calls for
scheduled backups via the SQLite online backup API, a tested restore path, a WAL
checkpointing policy, structured logs, and a disk-space watchdog on `/api/health` —
none of which exist yet.

## What Changes

- New `server/modules/backups.js`: manual (`POST /api/backups/run`, admin) and
  scheduled snapshots via `node:sqlite`'s online `backup()` — write to `.tmp`, verify
  `integrity_check`, chmod 0600, atomic rename, then `PRAGMA wal_checkpoint(TRUNCATE)`
  and retention pruning. The snapshot catalog is the filesystem (`data/backups/`), not
  a table — a DB-resident catalog would be stale after every restore.
- New `tools/restore.js`: offline, server-stopped restore that verifies the snapshot,
  refuses snapshots newer than the checked-out migrations, preserves the current DB as
  a `-pre-restore-` copy, and audits the restore.
- New `server/core/log.js`: structured one-JSON-object-per-line logging; the four
  `console.*` sites in `server/` move to it (`seed.created`, `module.mounted`,
  `server.listen`, `api.error`).
- `/api/health` gains role-gated fields (admin/manager only): `disk_free_bytes`,
  `db_bytes`, `disk_low`, `last_backup_at`. Anonymous callers keep exactly
  `{ ok, ephemeral }`.
- New admin-only `web/backups.html` (list, back-up-now, disk gauge, delete) plus a
  low-disk shell banner. Backups are disabled (400 `ephemeral`) on serverless hosting.
- Config via existing `settings` keys `backups.interval_min` / `backups.retain` (env
  fallback `OWLPOS_BACKUP_INTERVAL_MIN` / `OWLPOS_BACKUP_RETAIN`); defaults 60 min / 14.

## Non-goals

No snapshot download route (a snapshot is the full DB — scrypt hashes and member PII;
offsite copy is a host-level concern). No in-app restore. No new tables or DDL. No
change to `pos.finalizeOrder` or `admissions.checkCode`.

## Impact

New module + core logger + CLI tool + admin page; `server/main.js` (ctx gains
`dbPath`/`backupDir`, health handler), `server/core/http.js` (error log site),
`web/shell.js` (nav entry, banner), docs runbook, `tests/backups.test.js`, smoke
backup section. Zero npm dependencies throughout (`node:sqlite` `backup()`,
`fs.statfsSync` — both Node 22 built-ins).
