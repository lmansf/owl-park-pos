# Tasks — security-hardening

## Phase A — core (serial)

- [x] A1 Migration: `users` gains `must_change_password`, `failed_logins`,
      `locked_until`, `token_epoch`; flag seeded well-known accounts
- [x] A2 Mode + secret resolution per `createApp` (`OWLPOS_MODE`, fail-closed
      `OWLPOS_SECRET` in production); `/api/health` reports `mode`
- [x] A3 Token format `b64url(username).epoch.exp.sig`; epoch checked against the DB in
      `resolveUser`; legacy 3-part tokens fail closed
- [x] A4 Login: per-IP rate limit before scrypt, atomic lockout counters, dummy verify
      for unknown users, generic 401, audit every failure path
- [x] A5 `POST /api/auth/change-password` + `POST /api/auth/revoke-sessions` with epoch
      bump + same-response cookie re-issue; forced-change guard on the router
      (production only; me/logout/change-password allowlisted)
- [x] A6 Cookie flags: SameSite=Strict, Max-Age=43200, Secure in production/HTTPS

## Phase B — pos (builder → verifier)

- [x] B1 `auth.verifyManagerCredential`: active manager/admin, shared lockout counters,
      one generic 403; void/refund open to SELL with mandatory `approver`, audits carry
      `approved_by`

## Phase C — web

- [x] C1 login.html: change-password card (forced + on request), demo hint gated on
      health `mode`, client-side lockout hint
- [x] C2 shell.js: `password_change_required` redirect, Password button in the topbar
- [x] C3 pos.html: approver modal (bottom sheet at phone widths, manager username
      pre-filled), void/refund buttons for all sellers

## Phase D — tests

- [x] D1 core.test.js: lockout, uniform failure + 429, change-password policy/epoch,
      revocation, production fail-closed + forced change + cookie flags
- [x] D2 pos.test.js: approver required/role/lockout, audit attribution
- [x] D3 security.test.js: burst DoS, token forgery/epoch, audit hygiene (no passwords),
      username truncation, traversal regression
- [x] D4 smoke: refund re-auth, lockout walk, revoke-sessions
