# platform-core (delta)

## ADDED Requirements

### Requirement: Scheduled and manual database snapshots

The system SHALL take database snapshots with SQLite's online backup API — safe against
concurrent writes — on an operator-configurable schedule (default every 60 minutes,
`backups.interval_min = 0` disables) and on demand via `POST /api/backups/run` (admin
only; managers may list via `GET /api/backups`). A snapshot SHALL appear under its final
name in the backup directory only after passing `PRAGMA integrity_check`, SHALL be mode
0600, and SHALL be followed by `PRAGMA wal_checkpoint(TRUNCATE)`. Retention SHALL keep
the newest N snapshots (default 14) and SHALL never delete files that are not snapshots.
At most one backup runs per process (concurrent triggers get 409), snapshots are never
served over HTTP, and on ephemeral hosting the run route returns 400.

#### Scenario: Backup during a sale
- **WHEN** an admin triggers a backup while a cashier finalizes an order
- **THEN** the snapshot opens read-only with `integrity_check` = ok and its payments
  reconcile with its own paid orders.

#### Scenario: Rotation spares foreign files
- **WHEN** retention prunes old snapshots in a directory also containing `keep-this.db`
- **THEN** only files matching the snapshot naming pattern are deleted and the newest
  snapshot always survives.

### Requirement: Offline restore tool

`node tools/restore.js <snapshot> [--db <path>] [--force]` SHALL restore a snapshot with
the server stopped: it verifies `integrity_check`, refuses snapshots whose
`schema_migrations` contain names unknown to the checkout (older snapshots are fine —
pending migrations apply on next start), preserves the current database and its WAL/SHM
sidecars as a `-pre-restore-` copy, and appends a `backups.restore` audit row to the
restored database. It SHALL exit non-zero without touching the target on any failure.

#### Scenario: Newer snapshot refused
- **WHEN** the tool is pointed at a snapshot containing migration `999_future.sql` that
  the checkout does not have
- **THEN** it exits non-zero and the target database file is unchanged.

### Requirement: Operational health fields

`GET /api/health` SHALL remain public and SHALL return exactly `{ ok, ephemeral, mode }`
to anonymous, cashier, and gate callers. For admin and manager sessions it SHALL append
`disk_free_bytes`, `db_bytes`, `disk_low` (free space below 500 MB), and
`last_backup_at`; the shell SHALL show a persistent low-disk banner when `disk_low`.

#### Scenario: Anonymous caller learns nothing
- **WHEN** `/api/health` is fetched without a session
- **THEN** the response body has exactly the keys `ok`, `ephemeral`, and `mode`.

### Requirement: Structured logs

Server logs SHALL be one JSON object per line (`ts`, `level`, `event`, plus fields),
with every field JSON-encoded so injected newlines in user-controlled values cannot
forge records. Logs SHALL never contain passwords, password hashes, session tokens, or
whole request headers/bodies.

#### Scenario: Log injection defused
- **WHEN** a logged field contains `"\n{\"level\":\"info\"...`
- **THEN** exactly one log line is emitted and it parses as a single JSON record with
  the payload as string data.
