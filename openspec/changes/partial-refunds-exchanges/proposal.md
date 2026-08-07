# Change: partial-refunds-exchanges — per-line refunds and ticket exchanges

## Why

Refunds are all-or-nothing today (design risk #5: order → refunded, all tickets → void).
Real attractions desks constantly refund one rained-out ticket from a family order or
move a timed-entry ticket to another session. The full-refund-only model forces
refund-and-rebuy, which distorts reporting and capacity counts.

## What Changes

- **Partial refunds**: managers select lines (and quantities) of a paid order to refund.
  Selected tickets → void, their sessions' `sold` decremented, a negative payment row for
  the refunded amount, order gains status `partial_refund` when some lines remain live.
- **Exchanges**: a voided timed-entry ticket can be exchanged to another session with
  capacity — implemented as refund + reissue inside one `finalizeOrder`-adjacent
  transaction so capacity and ticket invariants hold; the new ticket references the
  original for audit.
- Reports and the daily journal treat partial refunds per-line (income reversal per
  product mapping), keeping the chart-of-accounts balance invariant.

## Non-goals

No refunds to a different tender than the original payment mix, no fee/penalty logic,
no customer-initiated (web) refunds — back office only.

## Impact

`server/modules/pos.js` (refund path), `web/pos.html` order search UI, reporting +
accounts journal treatment, migration for the new order status + ticket exchange link.
The `finalizeOrder`/`checkCode` chokepoint invariants are preserved — refund/exchange
stays inside the pos module's posting path.
