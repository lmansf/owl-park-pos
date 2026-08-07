# Change: deploy-demo-mode — retro-spec the hosted demo deployment

## Why

Commits `960affb` (Vercel serverless entry, ephemeral demo mode, in-app Help) and
`06ef9eb` (stateless HMAC session cookies) changed platform behavior without spec deltas.
The pos-mvp design was annotated after the fact ("sessions are stateless signed cookies
since the Vercel deployment") but the platform-core spec still describes the original
localhost-only, DB-backed-session design. This change closes that drift — it is
documentation only; the code it describes has already shipped and is verified.

## What Changes

Spec deltas only, all against **platform-core**:

- **MODIFIED** Session auth: sessions are stateless HMAC-signed tokens (`node:crypto`
  HMAC-SHA256, `OWLPOS_SECRET` or per-process random fallback), not `sessions` table rows.
  The table is retained in schema for compatibility but unused.
- **ADDED** Serverless demo deployment: the suite can run as a single serverless function
  (`api/index.js` via `vercel.json`), with the SQLite file in `/tmp` (`OWLPOS_DB`
  override) so each warm instance seeds a fresh, intentionally ephemeral demo dataset.
- **ADDED** Deployment self-description: `/api/health` reports whether the instance is
  ephemeral so UIs and users can tell a hosted demo from a durable local install.
- **ADDED** In-app Help: `web/help.html` documents the suite from inside the app.

## Non-goals

No code changes. No durable hosted storage, no real multi-instance session store, no
hardening of demo-grade auth (still seeded demo passwords, no lockout/2FA). The zero-npm
constraint is unchanged — the Vercel entry uses only the platform runtime, no dependencies.

## Impact

`openspec/changes/deploy-demo-mode/specs/platform-core/spec.md` only; archives into
`openspec/specs/platform-core/spec.md`. Existing behavior descriptions in
`openspec/changes/archive/2026-08-07-pos-mvp/` remain as historical record.
