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

