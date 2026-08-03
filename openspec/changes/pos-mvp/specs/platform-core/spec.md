# platform-core (delta)

## ADDED Requirements

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

#### Scenario: Cashier cannot administer catalog
- **WHEN** a user with role `cashier` calls `POST /api/catalog/products`
- **THEN** the response is 403 and no product is created.

#### Scenario: Login flow
- **WHEN** valid credentials are posted to `/api/auth/login`
- **THEN** a signed session cookie is set, and `GET /api/auth/me` returns the
  user's name and role until logout or expiry (12h).

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
