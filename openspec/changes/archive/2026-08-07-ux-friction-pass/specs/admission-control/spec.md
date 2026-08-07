# admission-control (delta)

## MODIFIED Requirements

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
