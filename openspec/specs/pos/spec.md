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

POS-channel payments SHALL be stamped with the cashier's open drawer session inside the
finalize transaction; a cash-bearing POS finalize with no open drawer for the order's
cashier SHALL fail 409 `no_open_drawer` with the same full-rollback behavior as
`capacity`. Card-only POS finalizes succeed without a drawer (attribution NULL).
Web-channel finalizes never require a drawer. The `finalizeOrder(db, ctx, orderId,
payments)` signature is unchanged — the drawer is resolved internally.

#### Scenario: Cash with change
- **WHEN** the total is $43.50 and the cashier enters $50 cash
- **THEN** the order finalizes, change $6.50 is displayed, and a payments row records both
  amounts.

#### Scenario: New tender is additive
- **WHEN** a `voucher` tender is registered and used for an exact-amount payment
- **THEN** the order finalizes through the unchanged posting path and the payments row
  records method `voucher`.

#### Scenario: Cash without a drawer cannot finalize
- **WHEN** a cashier with no open drawer session finalizes a POS order with any cash
  tender
- **THEN** the response is 409 `no_open_drawer`, the order stays `open` with no
  tickets, payments, or capacity movement, and the POS opens the drawer dialog.

### Requirement: Tender registry

`GET /api/pos/tenders` SHALL return the active tender list (method, label, change
behavior) for the POS UI to render. `payments.method` SHALL be validated against the
registry rather than a schema CHECK, and chart-of-accounts tender mappings keyed by
method name SHALL apply to registry tenders without accounts-module changes.

#### Scenario: Journal maps a new tender
- **WHEN** a `voucher` payment is taken and a tender mapping exists for `voucher`
- **THEN** that day's journal debits the mapped account and still balances.

### Requirement: Receipt and ticket output

After finalize, the POS SHALL show a print-view receipt (order number `P-XXXXXXXX`, lines,
taxes, tenders, change) and one ticket stub per issued ticket with holder-nameable label,
validity, session (if any), and the ticket code as text + Code 39 barcode. Browser print
styling makes each ticket its own page.

#### Scenario: Reprint
- **WHEN** a cashier opens a past paid order from order search
- **THEN** the receipt and all ticket stubs can be re-displayed and reprinted.

### Requirement: Order management (void/refund)

Sellers SHALL be able to void an unpaid order, refund a paid or partially refunded
order in full, or refund selected lines/quantities — every such request gated by the
manager re-auth approver credential established by security-hardening: the body must
carry `approver {username, password}` resolving to an active manager or admin. All
approver failure modes (missing, unknown, wrong password, wrong role, locked) SHALL
return one generic 403 `approval_required`; approver attempts SHALL count toward the
approver account's lockout counters and SHALL be rate-limited per IP (429) before any
password hashing. A refund SHALL: void exactly the affected tickets, decrement the
sessions those tickets actually occupy, record negative payment rows allocated across
the original tender methods (each capped by that method's remaining net), record the
event in `refunds`/`refund_lines` at line granularity, and append an audit entry.
Explicit line selections SHALL be validated server-side (integer ids belonging to the
order, integer qty within the unrefunded remainder, no duplicates) and SHALL refuse
lines whose tickets are already used or exchanged away; tickets voided by a session
cancellation remain refundable per line (consumed before valid tickets, releasing no
session capacity). An absent/empty selection is a full refund of everything still
live, voiding remaining tickets even if used (manager override). An order with some
quantities refunded and some live SHALL have status `partial_refund`; a fully
refunded order gets status `refunded` and `refunded_at`. Refunded tickets scan as
denied thereafter; remaining tickets stay valid.

#### Scenario: Refund blocks the gate
- **WHEN** a paid order is refunded and its ticket code is scanned
- **THEN** the scan is denied with reason "void".

#### Scenario: Partial refund leaves siblings valid
- **WHEN** one child ticket is refunded from a 3-ticket order
- **THEN** that ticket scans denied, the other two scan ok, and the negative payment row
  equals that line's total.

#### Scenario: Cancelled-session line refunds per line
- **WHEN** a session is cancelled (voiding its tickets) and one of its lines is then
  refunded by explicit selection
- **THEN** the refund succeeds for the line's unrefunded remainder and the cancelled
  session's sold count is not decremented again.

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

### Requirement: Session exchange

A valid timed-entry ticket SHALL be exchangeable to another session of the same event
with available capacity, in one transaction: old ticket → void, new ticket issued
referencing the original (`exchanged_from`), old session sold decremented, new session
sold incremented (rejecting the exchange when the target session is full). The target
session SHALL be validated like posting does (exists, not cancelled, same event, not the
current session), the target SHALL be reserved before the original is voided so a
capacity failure leaves the original untouched, and the route SHALL carry the same
seller-role + manager re-auth approver gate as refunds. No money moves for same-priced
exchanges. The replacement ticket SHALL be issued through the same internal issuance and
capacity routine that backs `pos.finalizeOrder`, so ticket issuance and session-capacity
movement remain a single chokepoint inside the pos module rather than a second
independent path.

#### Scenario: Exchange respects capacity
- **WHEN** a ticket is exchanged to a session with zero remaining capacity
- **THEN** the exchange is rejected with the same `capacity` error as posting, and the
  original ticket remains valid.

