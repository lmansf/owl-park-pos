# Tasks — pos-mvp

Team = one builder agent + one verifier agent per system (verifier runs the module's tests,
exercises the API/UI against the spec deltas, and files/fixes discrepancies).

## Phase A — platform-core (serial; Team Core)

- [x] A1 Server entry, router (`server/core/http.js`), static serving, error/JSON helpers
- [x] A2 DB open + migration runner + core migrations (users/sessions/settings/audit)
- [x] A3 Auth: scrypt, login/logout/me, requireRole, 12h sessions
- [x] A4 Seed: demo venue, users, tax group, products, programs, event + sessions, SAVE10
- [x] A5 App shell (nav, fetch helper, toasts, login page), `web/lib/barcode.js` (Code 39)
- [x] A6 `tests/core.test.js` + smoke skeleton `tools/smoke.js`

## Phase B — parallel system teams (after A)

- [x] B1 Team Catalog: products/tax/discounts API+UI, sellable feed (spec catalog-pricing)
- [x] B2 Team Events: events/sessions CRUD, bulk generate, availability API, capacity guard
      helpers (spec events-capacity)
- [x] B3 Team POS: sell screen, cart, tenders, finalizeOrder posting path, tickets/receipts,
      void/refund, order search (spec pos) — depends on B1/B2 contracts, not their landing
- [x] B4 Team Admissions: checkCode, scan API, gate UI + simulator (spec admission-control)
- [x] B5 Team Membership: programs, member lifecycle in posting, members UI, pass card
      (spec membership)
- [x] B6 Team Store: storefront, availability browse, checkout + simulated payment,
      confirmation/print-at-home, order recovery (spec online-store)
- [x] B7 Team Reporting: dashboard, four reports + CSV, reconciliation (spec reporting)

## Phase C — integration (serial; Team Core)

- [x] C1 Full smoke: seed → POS sale (cash+card, discount, timed session) → gate scans
      (ok/double/wrong-time) → web order → decline path → member sell + renew + scan →
      refund → reports reconcile
- [x] C2 Fix integration findings; `node --test tests/` green
- [ ] C3 README quickstart, AGENTS.md, screenshots optional; commit milestones
