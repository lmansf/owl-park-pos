# reporting Specification

## Purpose
Reporting: the back-office dashboard and daily sales/admissions reports, bucketed by
server-local day, derived read-only from orders, payments, tickets, and admits.
## Requirements
### Requirement: Dashboard

`web/index.html` (all back-office roles) SHALL show today at a glance: revenue, orders,
tickets sold, admits, in-park estimate (admits today), member count, next sessions with
fill %. Numbers come from `GET /api/reports/dashboard` computed live from the DB. For
managers and admins only, the dashboard payload additionally includes today's revenue by
item group (sales-based — order lines of orders paid today — top 5 groups plus
Ungrouped); other roles never receive it.

#### Scenario: Sale moves the needle
- **WHEN** a POS sale finalizes and the dashboard refreshes
- **THEN** revenue, orders, and tickets sold reflect it.

### Requirement: Core reports

`web/reports.html` (manager/admin) SHALL provide date-ranged reports, each as a table with
totals row and CSV download (`?format=csv`):
- **Sales summary** — per day: orders, units, gross, discounts, tax, net, by channel.
- **Product mix** — per product: units, gross, share.
- **Admissions** — per day: scans, admits, denials by reason; per-gate breakdown.
- **Memberships** — sold/renewed per program, active count, upcoming expirations (30 days).

#### Scenario: CSV matches table
- **WHEN** a sales summary is downloaded as CSV
- **THEN** rows and totals equal the on-screen table for the same filters.

### Requirement: Reconciliation invariants

The sales summary SHALL reconcile: net = gross − discounts; sum of payment rows per day
equals paid-order totals minus refunds; refunds appear as negatives on their refund date.
A `tools/smoke.js` assertion covers this after mixed activity.

#### Scenario: Refund day accounting
- **WHEN** an order paid Monday is refunded Tuesday
- **THEN** Monday's net is unchanged and Tuesday shows the negative amount.

### Requirement: Group rollups

The sales and admissions reports SHALL support grouping by item group over the standard
date filters: per-group revenue/qty/tax/discounts (sales) and admit counts (admissions),
resolved through the item-groups read exports. Products in multiple groups SHALL count
in each group, ungrouped products SHALL appear under "Ungrouped", and the report SHALL
disclose that multi-group membership can make group totals exceed the grand total. CSV
export SHALL be available in group mode.

#### Scenario: Food vs Admissions day
- **WHEN** the sales report is grouped by item group for today
- **THEN** each group row shows its revenue and the Ungrouped row absorbs products in no
  group.

#### Scenario: Multi-group disclosure
- **WHEN** a product belonging to two groups sells once
- **THEN** both group rows include it and the report footer notes the double-count rule.

### Requirement: Per-line refund reporting

Sales reports and the chart-of-accounts daily journal SHALL reflect partial refunds at
line granularity: income reversal against each refunded product's account mapping, tax
reversal per tax group, and the day's journal SHALL still balance (debits = credits)
over any mix of sales, partial refunds, and exchanges.

#### Scenario: Journal balances over a partial refund
- **WHEN** a day contains a 3-line sale and a 1-line partial refund
- **THEN** the journal for that day balances and the refunded product's income account
  shows the net of the two.

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

