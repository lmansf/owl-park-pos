# pos (delta)

## MODIFIED Requirements

### Requirement: Order management (void/refund)

Managers SHALL be able to void an unpaid order, refund a paid order in full, or refund
selected lines/quantities of a paid order. A refund SHALL: void exactly the affected
tickets, decrement the affected sessions' sold counts, record a negative payment row for
the refunded amount, and append an audit entry. An order with some lines refunded and
some live SHALL have status `partial_refund`; a fully refunded order keeps status
`refunded`. Refunded tickets scan as denied thereafter; remaining tickets stay valid.

#### Scenario: Refund blocks the gate
- **WHEN** a paid order is refunded and its ticket code is scanned
- **THEN** the scan is denied with reason "void".

#### Scenario: Partial refund leaves siblings valid
- **WHEN** one child ticket is refunded from a 3-ticket order
- **THEN** that ticket scans denied, the other two scan ok, and the negative payment row
  equals that line's total.

## ADDED Requirements

### Requirement: Session exchange

A valid timed-entry ticket SHALL be exchangeable to another session of the same event
with available capacity, in one transaction: old ticket → void, new ticket issued
referencing the original, old session sold decremented, new session sold incremented
(rejecting the exchange when the target session is full). No money moves for same-priced
exchanges.

#### Scenario: Exchange respects capacity
- **WHEN** a ticket is exchanged to a session with zero remaining capacity
- **THEN** the exchange is rejected with the same `capacity` error as posting, and the
  original ticket remains valid.
