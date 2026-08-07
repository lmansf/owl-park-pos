# pos (delta)

## MODIFIED Requirements

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

## ADDED Requirements

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
