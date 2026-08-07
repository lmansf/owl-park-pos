# pos Specification

## Purpose
Point of sale: the touch-first sell screen and order lifecycle — build, tender, and
finalize orders through `pos.finalizeOrder`, the only path that marks orders paid, issues
tickets, and moves session capacity.
## Requirements
### Requirement: Touch-first sell screen

`web/pos.html` (roles cashier/manager/admin) SHALL show a button grid of sellable products,
a cart with qty edit/remove, discount code entry, and running subtotal/tax/total. Adding an
event-linked product opens a session picker fed by the availability API. Layout must be
usable at compact touchscreen resolutions with touch-sized targets.

#### Scenario: Sell two adults and a planetarium entry
- **WHEN** the cashier taps Adult ×2 and Planetarium, picks the 14:00 session, and totals
- **THEN** the cart shows 3 lines with correct per-line tax and a grand total.

### Requirement: Tender and finalize

Checkout SHALL accept split tenders of `cash` (with change calculation) and `card_sim`
(always approves, generates a fake auth ref). When tenders cover the total, the order is
finalized through the shared posting path: order → paid, tickets issued, capacity counted,
audit logged. Insufficient tender cannot finalize.

#### Scenario: Cash with change
- **WHEN** the total is $43.50 and the cashier enters $50 cash
- **THEN** the order finalizes, change $6.50 is displayed, and a payments row records both
  amounts.

### Requirement: Receipt and ticket output

After finalize, the POS SHALL show a print-view receipt (order number `P-XXXXXXXX`, lines,
taxes, tenders, change) and one ticket stub per issued ticket with holder-nameable label,
validity, session (if any), and the ticket code as text + Code 39 barcode. Browser print
styling makes each ticket its own page.

#### Scenario: Reprint
- **WHEN** a cashier opens a past paid order from order search
- **THEN** the receipt and all ticket stubs can be re-displayed and reprinted.

### Requirement: Order management (void/refund)

Any seller (cashier/manager/admin) SHALL be able to void an unpaid order and refund a
paid order (full refund only) — but only with manager re-authentication: the request
body must carry `approver: {username, password}` resolving to an active `manager` or
`admin`. All approver failure modes (missing, unknown, wrong password, wrong role,
locked) SHALL return one generic 403 `approval_required`, and approver attempts SHALL
count toward the approver account's lockout counters. Effects are unchanged: status
change, tickets → void, session sold counts decremented, negative payment row. The audit
row SHALL record both the session user and `approved_by` (the approver's user id), never
the credential itself. Refunded tickets scan as denied thereafter.

#### Scenario: Refund blocks the gate
- **WHEN** a paid order is refunded and its ticket code is scanned
- **THEN** the scan is denied with reason "void".

#### Scenario: Cashier void with a manager standing by
- **WHEN** a cashier voids an open order and a manager enters their own credentials in
  the approver prompt
- **THEN** the void succeeds and the audit row carries the cashier as actor and the
  manager as `approved_by`.

#### Scenario: Gate credentials cannot approve
- **WHEN** a void or refund is submitted with an `approver` whose role is `gate` (or a
  wrong password, or no approver at all)
- **THEN** the response is 403 `approval_required` and the order is unchanged.

### Requirement: Shared posting path

Order finalization logic (`server/modules/pos.js` exporting `finalizeOrder`) SHALL be the
only code path that marks orders paid, issues tickets, and mutates session `sold` — used by
both POS checkout and the online store.

#### Scenario: One invariant set
- **WHEN** any channel attempts to finalize an order whose session lacks capacity
- **THEN** the same `capacity` error and rollback behavior occurs regardless of channel.

