# platform-core (delta)

## MODIFIED Requirements

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

## ADDED Requirements

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
