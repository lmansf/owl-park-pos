# Tasks — partial-refunds-exchanges

## Phase A — core (serial)

- [x] A1 Migration: `partial_refund` order status, ticket `exchanged_from` link
      (902_partial-refunds-exchanges.sql; also refunds/refund_lines +
      order_lines.refunded_qty; migrate() gained a foreign_keys=off directive
      for the orders CHECK rebuild, gated by foreign_key_check before COMMIT)

## Phase B — one team (builder → verifier)

- [x] B1 pos.js: per-line refund path (tickets void, sold decrement, negative payment,
      audit) inside the posting transaction discipline
- [x] B2 pos.js: session exchange (void + reissue, capacity-guarded, linked)
- [x] B3 pos.html: line selection UI in order search; exchange picker fed by
      availability API
- [x] B4 Reporting + accounts journal: per-line reversal; balance test over mixed day
- [x] B5 Tests: partial refund, sibling tickets stay valid, exchange ok/full-session,
      gate denies voided/exchanged-away codes; smoke extended (tests/refunds.test.js)

## Phase C — integration (serial)

- [ ] C1 Full suite + smoke green; archive
      (suite 293/293 + smoke 70 checks green on the feature branch — archive at merge)
