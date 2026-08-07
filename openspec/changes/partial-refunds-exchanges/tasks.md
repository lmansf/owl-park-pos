# Tasks — partial-refunds-exchanges

## Phase A — core (serial)

- [ ] A1 Migration: `partial_refund` order status, ticket `exchanged_from` link

## Phase B — one team (builder → verifier)

- [ ] B1 pos.js: per-line refund path (tickets void, sold decrement, negative payment,
      audit) inside the posting transaction discipline
- [ ] B2 pos.js: session exchange (void + reissue, capacity-guarded, linked)
- [ ] B3 pos.html: line selection UI in order search; exchange picker fed by
      availability API
- [ ] B4 Reporting + accounts journal: per-line reversal; balance test over mixed day
- [ ] B5 Tests: partial refund, sibling tickets stay valid, exchange ok/full-session,
      gate denies voided/exchanged-away codes; smoke extended

## Phase C — integration (serial)

- [ ] C1 Full suite + smoke green; archive
