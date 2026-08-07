# admission-control Specification

## Purpose
Gate admission scanning: validate ticket and member codes through the single
`admissions.checkCode` chokepoint, record every scan as an `admits` row, and give gate
staff a fast scan UI with clear ok/deny feedback.
## Requirements
### Requirement: Single validation entry point

`server/modules/admissions.js` SHALL export `checkCode(db, code, gate)` handling both ticket
(`T-…`) and member (`M-…`) codes, and expose it as `POST /api/admissions/scan` (roles gate/
cashier/manager/admin). Every scan — ok or denied — SHALL be recorded in `admits`.

#### Scenario: Unknown code
- **WHEN** a code matching no ticket or member is scanned
- **THEN** the response is denied with reason "unknown" and an admits row is still written.

### Requirement: Ticket validation rules

A ticket scan SHALL be OK only if: status `valid`, now within `valid_from..valid_to`,
`uses_remaining > 0`, and — for session tickets — now within the session's entry window
(session start −30 min to session end). An OK scan decrements `uses_remaining` and sets
status `used` at zero. Denials carry machine-readable reasons: `void`, `expired`,
`not_yet_valid`, `exhausted`, `wrong_session_time`.

#### Scenario: Double entry
- **WHEN** a single-use ticket is scanned twice
- **THEN** the first scan admits; the second is denied with reason "exhausted".

#### Scenario: Early planetarium arrival
- **WHEN** a 14:00-session ticket is scanned at 09:00 the same day
- **THEN** it is denied with reason "wrong_session_time" and remains valid for later.

### Requirement: Member pass validation

A member code scan SHALL be OK while the membership is `active` and unexpired, with no use
limit, and the result includes the member's name and program so gate staff can greet them.
Expired or suspended members are denied with reason `expired`/`suspended`.

#### Scenario: Lapsed member
- **WHEN** a member whose `expires_at` is yesterday scans their pass
- **THEN** entry is denied with reason "expired" and the UI suggests renewal at POS.

### Requirement: Gate UI and simulator

`web/admissions.html` SHALL provide: a large scan input (auto-focus, Enter submits — i.e.
keyboard-wedge compatible), a big green OK / red DENIED result panel with name/reason, the
day's admit count, and a recent-scans list. A "simulator" drawer lists today's issued
tickets/members (manager+ only) with one-click scan for demos and testing.

The gate name SHALL persist across reloads (client-side storage; the value remains just
the string sent to `/api/admissions/scan`, which sanitizes/defaults it server-side). The
scan input SHALL regain focus after a click on non-interactive page chrome and when the
tab becomes visible again, so a stray tap or app switch never silently eats the next
scan.

#### Scenario: Wedge-style scan
- **WHEN** a code followed by Enter lands in the scan input
- **THEN** the result panel updates without any mouse interaction and focus returns to the
  input for the next scan.

#### Scenario: Side gate stays the side gate
- **WHEN** an operator sets the gate to "side" and the page reloads
- **THEN** the gate field still reads "side" and subsequent admits record that gate.

#### Scenario: Stray tap cannot eat a scan
- **WHEN** the operator taps the result panel and a barcode is scanned immediately after
- **THEN** the code lands in the scan input and is submitted normally.

