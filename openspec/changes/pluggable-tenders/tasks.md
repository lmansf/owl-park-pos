# Tasks — pluggable-tenders

## Phase A — core (serial)

- [ ] A1 Migration: relax `payments.method` CHECK to registry-driven validation

## Phase B — one team (builder → verifier)

- [ ] B1 pos.js: tender registry (cash, card_sim, voucher demo), `GET /api/pos/tenders`,
      finalizeOrder validates methods against the registry (invariants untouched)
- [ ] B2 pos.html: tender buttons rendered from the registry
- [ ] B3 accounts.js: default mapping for `voucher`; journal test with mixed tenders
- [ ] B4 Tests: split tender with voucher, unknown method rejected, change only for
      change-bearing tenders; smoke takes a voucher payment

## Phase C — integration (serial)

- [ ] C1 Full suite + smoke green; archive
