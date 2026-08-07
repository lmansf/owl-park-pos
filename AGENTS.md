# owl-park-pos — agent notes

Owl Park Point of Sale: self-contained attractions ticketing suite for the fictional Owl
Park. Simulated payments; auth is demo-grade in the default demo mode — never expose
demo mode beyond localhost. `OWLPOS_MODE=production` hardens auth (fail-closed
`OWLPOS_SECRET` + `OWLPOS_BOOTSTRAP_ADMIN_PASSWORD`, no seeded demo credentials,
forced password change, `tools/users.js` account admin; spec:
`openspec/specs/platform-core/spec.md`).

- Run: `node server/main.js` → back office http://localhost:4650 (admin/admin,
  manager/manager, cashier/cashier, gate/gate), guest store at /store/. DB is
  `data/owlpark-pos.db` (gitignored); delete it for a fresh reseed.
- Test: `node --test` (all of tests/). End-to-end: `node tools/smoke.js`. Both use scratch
  DBs and ephemeral ports — never bind 4650 in tests.
- Hard constraint: ZERO npm dependencies and zero network at runtime. Node 22 built-ins only
  (`node:http`, `node:sqlite`, `node:crypto`). Frontend is vanilla JS; no CDN/fonts/assets.
- Live contracts (module export signatures, API shapes, code formats, who owns which
  files): `openspec/specs/<system>/spec.md` — one folder per system, and the only
  authority. `openspec/changes/archive/` holds the original design docs as history:
  useful for the why, but its signatures have drifted (it still shows
  `posting.finalizeOrder(db, orderId, payments)`), so never treat it as current. When
  code and a spec disagree, fix one of them — don't add a third source of truth. All DDL
  lives in `server/migrations/` (core-owned); modules write no DDL.
- Two invariant chokepoints: `pos.finalizeOrder` (the only path that marks orders paid,
  issues tickets, moves session capacity — POS and web store both use it) and
  `admissions.checkCode` (the only admit/deny path; always writes an `admits` row).
- Membership on order lines is structured: `order_lines.member_id` (renewal target,
  stamped at finalize) and `member_intent` (server-written JSON {name, email} for a new
  member) — pos.js writes them, finalizeOrder consumes them. Line descriptions are
  display-only; never parse member info out of them.
- Day boundaries ("today", report bucketing) are server-local time throughout.
