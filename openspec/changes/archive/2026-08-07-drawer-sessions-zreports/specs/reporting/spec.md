# reporting (delta)

## ADDED Requirements

### Requirement: Drawer reconciliation report

`web/reports.html` (manager/admin) SHALL provide a fifth date-ranged report, **Drawer
sessions** (`GET /api/reports/drawers`, CSV via `?format=csv`), in the uniform sections
shape: closed drawer sessions bucketed by local close day (z_number, cashier, terminal,
float, cash net of change, paid in/out, expected, counted, over/short with a totals row
that sums over/short but never Z numbers), plus an **Unattributed POS cash** line —
`SUM(amount_cents − change_cents)` of cash payments on pos-channel orders with no
`drawer_session_id` in range. With enforcement live that line SHALL be 0; pre-drawer
history or refunds taken without an open drawer surface there visibly rather than
silently.

#### Scenario: Park-day over/short
- **WHEN** two drawers close in a day, one 50 cents short and one exactly balanced
- **THEN** the report shows both rows and the totals line shows −50.

#### Scenario: Legacy cash is visible
- **WHEN** a pos-channel cash payment row carries no drawer attribution
- **THEN** the Unattributed POS cash line reports its amount instead of 0.
