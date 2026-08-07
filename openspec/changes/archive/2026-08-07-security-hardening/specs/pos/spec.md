# pos (delta)

## MODIFIED Requirements

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
