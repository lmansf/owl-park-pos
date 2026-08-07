# Change: security-hardening — lockout, forced rotation, revocation, manager re-auth

## Why

Roadmap §1 calls auth "the biggest gap": seeded well-known passwords, no lockout or
rate-limit, a silent random-secret fallback that would break (or weaken) a real
deployment, non-revocable stateless tokens, and void/refund gated only by whoever is
logged into the terminal. Each of these is fine for a localhost demo and disqualifying
for an SMB install.

## What Changes

- **`OWLPOS_MODE`** (`demo` default / `production`): demo preserves today's behavior
  exactly; production fails closed on a missing/weak `OWLPOS_SECRET` (>= 32 bytes),
  forces seeded accounts to set a real password before doing anything else, sets
  `Secure` cookies, and hides the demo-credentials hint. `VERCEL` never implies
  production.
- **Login hardening** (both modes): per-IP rate limit answered before any scrypt work
  (429 + `Retry-After`); per-account lockout (5 consecutive failures → 15 min) via
  atomic counters on `users`; every failure audited (`auth.login_failed`,
  `auth.login_locked`); one generic 401 body for unknown user / wrong password / locked,
  with a dummy scrypt verify so unknown usernames cost the same as wrong passwords.
- **Session revocation**: tokens gain a signed per-user `token_epoch`
  (`b64url(username).epoch.exp.sig`); `POST /api/auth/change-password` and
  `POST /api/auth/revoke-sessions` (self, or admin targeting `user_id`) bump the epoch,
  killing every other outstanding cookie; the caller is re-issued a fresh cookie in the
  same response. Legacy 3-part tokens fail closed (one re-login after deploy).
- **Cookie hardening**: `SameSite=Lax` → `Strict`, `Max-Age` matching the 12h expiry,
  `Secure` in production/HTTPS.
- **Manager re-auth for void/refund**: routes open to all sellers but require an
  `approver` credential resolving to an active manager/admin; approver attempts share
  the lockout counters (no password oracle) and audits carry `approved_by`.
- Migration adds `must_change_password`, `failed_logins`, `locked_until`, `token_epoch`
  to `users`; seed flags the four demo accounts.

## Non-goals

No 2FA, no TLS termination (roadmap §1 leaves that to a proxy), no denylist-based
revocation (epochs were chosen precisely because serverless demo instances have
per-instance DBs), no per-station gate accounts, no password expiry/rotation schedule.
`pos.finalizeOrder` and `admissions.checkCode` are untouched.

## Impact

Migration (core-owned DDL), `server/core/auth.js` (token format, lockout, new routes),
`server/core/http.js` (router guard hook), `server/main.js` (mode/secret resolution,
health `mode`), `server/core/seed.js`, `server/modules/pos.js` (void/refund re-auth),
`web/login.html` (change-password card, demo-hint gating), `web/shell.js`
(`password_change_required` redirect, change-password entry), `web/pos.html` (approver
modal), tests + smoke. Existing sessions are invalidated once at deploy (token format
change).
