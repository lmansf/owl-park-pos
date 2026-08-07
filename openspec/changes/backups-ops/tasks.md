# Tasks — backups-ops

## Phase A — core plumbing (serial)

- [x] A1 `server/core/log.js`: `log(level, event, fields)` / `logError` emitting JSON
      lines; swap the four `console.*` sites in `server/main.js` + `server/core/http.js`
- [x] A2 `server/main.js`: ctx gains `dbPath` + `backupDir`; `/api/health` appends
      disk/backup fields for admin/manager only (anonymous shape unchanged)

## Phase B — backups module + restore tool

- [x] B1 `server/modules/backups.js`: `runBackup` (tmp → verify → 0600 → rename →
      wal_checkpoint → prune → audit), `listBackups`, `lastBackupAt`; routes
      GET `/api/backups` (admin+manager), POST `/api/backups/run` (admin, 409 mutex,
      400 on serverless), DELETE `/api/backups/:name` (admin, pattern + containment
      validation); unref'd scheduler off on serverless and at interval 0
- [x] B2 `tools/restore.js`: offline restore — integrity check, newer-schema refusal,
      fresh-WAL warning, pre-restore preservation, audit row, JSON summary

## Phase C — UI + docs

- [x] C1 `web/backups.html` (admin-only nav entry): status line, back-up-now, snapshot
      table with card layout at 390 px, delete with confirm, restore instructions
- [x] C2 `web/shell.js`: low-disk banner from health `disk_low`
- [x] C3 `docs/user-guide.md`: Backups page section + backup/restore runbook

## Phase D — verification

- [x] D1 `tests/backups.test.js`: snapshot validity + 0600, consistency under
      concurrent writes, 409 mutex, rotation with decoy survival, authz matrix,
      health field gating, traversal probes, static-server 404 for the backup dir,
      log injection, ephemeral/interval-0 guards, restore round-trip + refusals
- [x] D2 `tools/smoke.js`: admin backup → snapshot reconciles internally → listed;
      anonymous health stays minimal
