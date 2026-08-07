# chart-of-accounts Specification

## Purpose
Lightweight general-ledger layer: GL accounts, product-to-account revenue mapping, and a
balanced daily journal view so sales activity can be handed to bookkeeping without a full
accounting system.
## Requirements
### Requirement: Account management

`web/accounts.html` (admin/manager; edits admin-only) SHALL manage GL accounts (code,
name, kind: asset/liability/income/expense/clearing, active) and the mapping table:
each product → income account, each tax group → liability account, each tender method →
clearing account, discounts → a contra account. On first mount with an empty accounts
table the module seeds the default chart and sensible default mappings (per design.md).

#### Scenario: Fresh install has a working chart
- **WHEN** the server starts on an existing database that predates this change
- **THEN** the default chart and mappings exist and the journal endpoint works with no
  manual setup.

### Requirement: Balanced daily journal

`GET /api/accounts/journal?from=&to=` (manager/admin) SHALL derive a per-day journal from
actual activity: debit tender clearing accounts (payments net of change), credit income
per product mapping (net of proportional discounts), credit tax liability per tax group,
debit the discounts account, with refunds as exact reversals on their refund date. For
every day, total debits SHALL equal total credits, and a test asserts this over mixed
activity (sale, discounted sale, web order, refund). CSV export via `&format=csv`.

#### Scenario: Books balance after a messy day
- **WHEN** the day includes a cash+card sale with SAVE10, a web order, and a refund
- **THEN** the journal for that day balances to the cent, and the refund day nets the
  reversal.

### Requirement: Unmapped activity is visible, not lost

Activity with no mapping (e.g. a new product never mapped) SHALL post to a clearly-labeled
suspense line (account code 9999 "Unmapped") rather than being dropped, keeping the
journal balanced.

#### Scenario: New product before mapping
- **WHEN** a just-created product sells before an income account is assigned
- **THEN** its revenue appears on the Unmapped line for that day.

