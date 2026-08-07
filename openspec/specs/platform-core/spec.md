# platform-core Specification

## Purpose
Platform foundation: the zero-dependency Node 22 server, SQLite storage with core-owned
migrations, session auth and roles, module registry with graceful degradation, and the
shared HTTP/JSON conventions every module builds on.
## Requirements
### Requirement: Zero-dependency local server

The system SHALL run as a single Node 22 process (`node server/main.js`) listening on
`http://localhost:4650`, using only Node built-ins (`node:http`, `node:sqlite`, `node:crypto`,
`node:fs`, `node:test`). `npm install` SHALL NOT be required, and no page or API call may
reach the network beyond localhost.

#### Scenario: Cold start offline
- **WHEN** the repo is cloned on a machine with no internet and `node server/main.js` is run
- **THEN** the server starts, creates and migrates `data/owlpark-pos.db`, seeds demo data, and
  serves the back-office at `http://localhost:4650/`.

### Requirement: Migrations and seed

Schema SHALL be defined by ordered SQL files in `server/migrations/` applied exactly once
(tracked in `schema_migrations`). Seeding SHALL be idempotent: it runs only when the DB has
no users, and produces the demo venue described in design.md.

#### Scenario: Restart is a no-op
- **WHEN** the server is started a second time against an existing DB
- **THEN** no migration re-runs, the seed does not duplicate data, and existing data is intact.

### Requirement: Session auth with roles

The system SHALL provide `POST /api/auth/login` (username/password → sets `opsid` HttpOnly
cookie), `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password`,
and `POST /api/auth/revoke-sessions`. Passwords SHALL be stored as scrypt hashes. Roles
are `admin`, `manager`, `cashier`, `gate`; every non-store API route declares allowed
roles and returns 401 (no session) or 403 (wrong role).

Sessions SHALL be stateless HMAC-signed tokens carrying the user's `token_epoch` inside
the signed payload (`b64url(username).epoch.exp.sig`); a token whose epoch no longer
matches the user's row is dead. Cookies SHALL be `HttpOnly; SameSite=Strict` with a
`Max-Age` matching the 12h token expiry, and `Secure` in production mode or on HTTPS
hosts.

Login and the current-password check on `/api/auth/change-password` SHALL be
rate-limited per IP before any password hashing (429 with `Retry-After`), and failed
current-password attempts SHALL count toward the account's lockout counters. Accounts
SHALL lock for 15 minutes after 5 consecutive failures. All login failures — unknown
username, wrong password, locked account — SHALL return one identical generic 401,
cost equivalent hashing work, and append an audit row.

#### Scenario: Cashier cannot administer catalog
- **WHEN** a user with role `cashier` calls `POST /api/catalog/products`
- **THEN** the response is 403 and no product is created.

#### Scenario: Login flow
- **WHEN** valid credentials are posted to `/api/auth/login`
- **THEN** a signed session cookie is set, and `GET /api/auth/me` returns the
  user's name and role until logout, expiry (12h), or revocation.

#### Scenario: Multi-instance login is not a loop
- **WHEN** two server instances share `OWLPOS_SECRET` and a login on instance A is
  followed by a request served by instance B
- **THEN** instance B accepts the cookie without any shared session store.

#### Scenario: Lockout does not leak
- **WHEN** an account is locked after 5 consecutive failures and the correct password is
  then submitted
- **THEN** the response is the same generic 401 as a wrong password, and an
  `auth.login_locked` audit row is written.

#### Scenario: Revocation kills other sessions immediately
- **WHEN** a signed-in user calls `POST /api/auth/revoke-sessions` (or changes their
  password)
- **THEN** every other cookie for that user fails on its next request, while the caller
  continues on the fresh cookie set in the same response.

### Requirement: Back-office app shell

A shared shell (`web/shell.css`, `web/shell.js`) SHALL provide: top navigation to Dashboard,
POS, Admissions, Catalog, Events, Members, Reports; the signed-in user + logout; a `op.api()`
fetch helper that surfaces API errors as toasts; and role-aware nav (e.g. `gate` sees only
Admissions). Unauthenticated visits to any back-office page redirect to `/login.html`.

#### Scenario: Gate operator lands on Admissions
- **WHEN** user `gate` logs in
- **THEN** they are taken to Admissions and the nav shows only pages their role can use.

### Requirement: Audit log

State-changing actions (login, failed and locked login attempts, password changes,
session revocations, order finalize, void/refund, product/price/member changes, manual
admits) SHALL append to `audit_log` with actor, action, and detail JSON. Attempted
usernames in failure rows SHALL be truncated (≤ 64 chars) and passwords SHALL never
appear in any audit detail.

#### Scenario: Void is attributed
- **WHEN** a manager voids an order
- **THEN** an `audit_log` row records that manager's user id, action `order.void`, and the
  order id.

#### Scenario: Failed logins are operator-visible
- **WHEN** an attacker probes an account with wrong passwords
- **THEN** each attempt that reaches credential verification writes an
  `auth.login_failed` row with the (truncated) username and source IP.

### Requirement: Serverless demo deployment

The suite SHALL be deployable as a single serverless function: `api/index.js` builds the
app via `server/main.js`'s exported `createApp(dbPath)` and dispatches every request
through the same router; `vercel.json` rewrites all paths to that function and includes
`web/` and `server/` files. The database path SHALL default to `/tmp/owlpark-pos.db` and
be overridable via `OWLPOS_DB`. Cold starts on an empty database SHALL migrate and seed
the standard demo dataset — hosted instances are intentionally ephemeral.

#### Scenario: Cold start serves a fresh demo
- **WHEN** a new serverless instance receives its first request
- **THEN** the DB is created in `/tmp`, migrated, seeded, and the request is served by the
  same code paths as a local install.

### Requirement: Deployment self-description

`GET /api/health` SHALL report the deployment mode, including an `ephemeral` flag (true
when running on a hosted/serverless platform), so users and UIs can distinguish a
throwaway hosted demo from a durable local install.

#### Scenario: Hosted demo announces itself
- **WHEN** `/api/health` is called on a Vercel deployment
- **THEN** the response includes `ephemeral: true`.

### Requirement: In-app Help

The back office SHALL serve `web/help.html`, a self-contained user guide describing the
suite's surfaces and demo credentials, reachable from the app without leaving localhost
(no external links required to operate).

#### Scenario: Help is available offline
- **WHEN** a user opens Help on a machine with no internet
- **THEN** the full guide renders from local static files.

### Requirement: Phone-width back-office rendering

Back-office pages SHALL render without horizontal page overflow at phone widths
(~390px): wide data tables scroll horizontally within their own bounds, multi-column
form and layout grids collapse to a single column, and form controls use a 16px font
size on small screens so iOS Safari does not zoom on focus. Desktop layout SHALL be
unchanged (small-screen rules apply only below their breakpoints).

#### Scenario: POS sell screen on a phone
- **WHEN** the POS sell screen is opened at a 390px-wide viewport
- **THEN** the product grid and cart stack vertically and no element forces the page to
  scroll horizontally.

#### Scenario: Report table on a phone
- **WHEN** a report with many columns is viewed at phone width
- **THEN** the table scrolls horizontally inside its own container while the page body
  does not.

### Requirement: Deployment modes

The server SHALL run in one of two modes resolved at `createApp` time from
`OWLPOS_MODE`: `demo` (default — per-process random secret fallback, no forced password
change, demo credential hints shown) and `production`. In production mode the server
SHALL fail closed before listening unless `OWLPOS_SECRET` decodes to at least 32 bytes,
SHALL set `Secure` cookies, and SHALL hide demo credential hints. `VERCEL` SHALL never
imply production. `GET /api/health` SHALL report the active `mode`.

#### Scenario: Production without a secret refuses to start
- **WHEN** `OWLPOS_MODE=production` and `OWLPOS_SECRET` is unset or under 32 bytes
- **THEN** `createApp` throws and nothing listens.

#### Scenario: Demo behavior is unchanged
- **WHEN** the server starts with no `OWLPOS_MODE`
- **THEN** login, cookies, and seeded accounts behave as before, with a per-process
  random secret fallback.

### Requirement: Forced password change

Seeded well-known accounts SHALL carry `must_change_password = 1`. In production mode, a
flagged user's requests SHALL be answered 403 `password_change_required` on every
authenticated route except `/api/auth/change-password`, `/api/auth/logout`, and
`/api/auth/me`, until they set a new password (≥ 8 chars, different from username and
current password). Demo mode SHALL NOT enforce the flag.

#### Scenario: Seeded admin is fenced in until rotation
- **WHEN** `admin/admin` signs in on a production-mode server and calls any business API
- **THEN** the response is 403 `password_change_required`; after a successful
  change-password call the same request succeeds on the freshly issued cookie.

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

