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
cookie), `POST /api/auth/logout`, and `GET /api/auth/me`. Passwords SHALL be stored as
scrypt hashes. Roles are `admin`, `manager`, `cashier`, `gate`; every non-store API route
declares allowed roles and returns 401 (no session) or 403 (wrong role).

Sessions SHALL be stateless HMAC-signed tokens (HMAC-SHA256 over username + expiry via
`node:crypto`), verified on every request without a database read. The signing secret
SHALL come from `OWLPOS_SECRET` when set (required for multi-instance deployments so all
instances verify the same signature) and otherwise fall back to a per-process random
secret (sessions then survive only as long as the process — acceptable for demo-grade
auth). The `sessions` table SHALL be retained in the schema for compatibility but SHALL
NOT be read or written by auth.

#### Scenario: Cashier cannot administer catalog
- **WHEN** a user with role `cashier` calls `POST /api/catalog/products`
- **THEN** the response is 403 and no product is created.

#### Scenario: Login flow
- **WHEN** valid credentials are posted to `/api/auth/login`
- **THEN** a signed session cookie is set, and `GET /api/auth/me` returns the
  user's name and role until logout or expiry (12h).

#### Scenario: Multi-instance login is not a loop
- **WHEN** two server instances share `OWLPOS_SECRET` and a login on instance A is
  followed by a request served by instance B
- **THEN** instance B accepts the cookie without any shared session store.

### Requirement: Back-office app shell

A shared shell (`web/shell.css`, `web/shell.js`) SHALL provide: top navigation to Dashboard,
POS, Admissions, Catalog, Events, Members, Reports; the signed-in user + logout; a `op.api()`
fetch helper that surfaces API errors as toasts; and role-aware nav (e.g. `gate` sees only
Admissions). Unauthenticated visits to any back-office page redirect to `/login.html`.

#### Scenario: Gate operator lands on Admissions
- **WHEN** user `gate` logs in
- **THEN** they are taken to Admissions and the nav shows only pages their role can use.

### Requirement: Audit log

State-changing actions (login, order finalize, void/refund, product/price/member changes,
manual admits) SHALL append to `audit_log` with actor, action, and detail JSON.

#### Scenario: Void is attributed
- **WHEN** a manager voids an order
- **THEN** an `audit_log` row records that manager's user id, action `order.void`, and the
  order id.

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

