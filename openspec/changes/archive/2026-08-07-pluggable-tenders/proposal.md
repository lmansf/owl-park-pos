# Change: pluggable-tenders — a formal tender interface

## Why

Design risk #1 deferred this: payments are a hardcoded cash/card_sim pair inside pos.js.
Adding any tender (gift card, voucher, external terminal, house account) today means
editing the posting path — the one place the design says must stay invariant. A small
registry makes tenders additive instead.

## What Changes

- A server-side tender registry: each tender declares `method` (the enum key),
  display label, whether it computes change, and an `authorize(amount, meta)` hook
  (simulated for all built-ins). `cash` and `card_sim` become the first two entries,
  behavior unchanged.
- The `payments.method` CHECK constraint widens to registry-driven validation so new
  tenders need no DDL.
- POS tender UI renders from the registry (`GET /api/pos/tenders`); chart-of-accounts
  tender mappings (`account_map` scope `tender`, keyed by method name) work for new
  tenders automatically.
- One demo tender added to prove the seam: `voucher` (fixed-code, always approves),
  exercised by tests and smoke.

## Non-goals

No real payment-processor integration, no network at runtime (unchanged hard
constraint), no split-tender rule changes, no refunds-to-different-tender.

## Impact

`server/modules/pos.js` (registry + tender routes; finalizeOrder consumes the registry
but its invariants are untouched), `web/pos.html` tender buttons, migration relaxing the
`payments.method` CHECK, accounts default mapping for `voucher`.
