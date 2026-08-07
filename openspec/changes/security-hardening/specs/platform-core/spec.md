# platform-core (delta)

## MODIFIED Requirements

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

Login SHALL be rate-limited per IP before any password hashing (429 with `Retry-After`),
and accounts SHALL lock for 15 minutes after 5 consecutive failures. All login failures
— unknown username, wrong password, locked account — SHALL return one identical generic
401, cost equivalent hashing work, and append an audit row.

#### Scenario: Cashier cannot administer catalog
- **WHEN** a user with role `cashier` calls `POST /api/catalog/products`
- **THEN** the response is 403 and no product is created.

#### Scenario: Login flow
- **WHEN** valid credentials are posted to `/api/auth/login`
- **THEN** a signed session cookie is set, and `GET /api/auth/me` returns the
  user's name and role until logout, expiry (12h), or revocation.

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

## ADDED Requirements

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
