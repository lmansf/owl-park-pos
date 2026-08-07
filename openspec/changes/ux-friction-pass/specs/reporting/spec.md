# reporting (delta)

## ADDED Requirements

### Requirement: Report runner ergonomics

The Reports page SHALL validate the date range client-side (`from ≤ to`) with an inline
message instead of issuing a request, disable Run while a report is pending (no
double-fire on slow ranges), and show an actionable failure message rather than a blank
pane when a run errors. The dashboard SHALL render skeleton KPI tiles until the first
fetch resolves.

#### Scenario: Inverted range never hits the API
- **WHEN** From is after To and Run is clicked
- **THEN** an inline message says to swap the dates and no report request is sent.

#### Scenario: Slow report cannot be double-run
- **WHEN** Run is clicked while a report is loading
- **THEN** the second click is a no-op (the button is disabled until the first settles).
