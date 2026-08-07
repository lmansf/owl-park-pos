# owl-park-pos — agent notes

Owl Park Point of Sale: self-contained attractions ticketing suite for the fictional Owl
Park. Simulated payments; auth is demo-grade in the default demo mode — never expose
demo mode beyond localhost. `OWLPOS_MODE=production` hardens auth (fail-closed
`OWLPOS_SECRET`, forced password change; spec: `openspec/specs/platform-core/spec.md`).

- Run: `node server/main.js` → back office http://localhost:4650 (admin/admin,
  manager/manager, cashier/cashier, gate/gate), guest store at /store/. DB is
  `data/owlpark-pos.db` (gitignored); delete it for a fresh reseed.
- Test: `node --test` (all of tests/). End-to-end: `node tools/smoke.js`. Both use scratch
  DBs and ephemeral ports — never bind 4650 in tests.
- Hard constraint: ZERO npm dependencies and zero network at runtime. Node 22 built-ins only
  (`node:http`, `node:sqlite`, `node:crypto`). Frontend is vanilla JS; no CDN/fonts/assets.
- Architecture + frozen cross-module contracts (module export signatures, API shapes, code
  formats, who owns which files): `openspec/changes/archive/2026-08-07-pos-mvp/design.md`.
  Current per-system specs live in `openspec/specs/`. All DDL lives in
  `server/migrations/` (core-owned); modules write no DDL.
- Two invariant chokepoints: `pos.finalizeOrder` (the only path that marks orders paid,
  issues tickets, moves session capacity — POS and web store both use it) and
  `admissions.checkCode` (the only admit/deny path; always writes an `admits` row).
- Sharp edge: membership info on order lines is text-encoded in the line description
  ("(renewal #N)" / "(for Name <email>)") because order_lines has no member column; pos.js
  writes it, store.js parses it — change both together or add a column via migration.
- Day boundaries ("today", report bucketing) are server-local time throughout.
