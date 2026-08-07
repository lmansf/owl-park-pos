# catalog-pricing (delta)

## ADDED Requirements

### Requirement: Product catalog CRUD

Managers/admins SHALL manage products (`kind` = ticket | membership | addon) with SKU, name,
price (integer cents), tax group, optional linked event (timed tickets), optional membership
program, validity window (days from purchase), and max uses. Products can be deactivated but
never deleted once sold. UI: `web/catalog.html`.

#### Scenario: Deactivate keeps history
- **WHEN** a product that appears on past orders is deactivated
- **THEN** it disappears from POS/store sell surfaces but past orders and reports still show it.

### Requirement: Tax groups

Each product belongs to a tax group with a basis-point rate. Tax SHALL be computed per line
(`round(line_subtotal * rate_bp / 10000)`) and summed onto the order; rates are editable by
admins only.

#### Scenario: Tax on a mixed cart
- **WHEN** a cart holds two products in different tax groups
- **THEN** each line carries its own tax and the order total equals subtotal + sum of line
  taxes − discounts.

### Requirement: Discount codes

The system SHALL support order-level discount codes: percent or fixed amount, active flag.
Applying a code recomputes the order totals; invalid or inactive codes are rejected with a
clear error. Discounts apply before tax proportionally across taxable lines.

#### Scenario: SAVE10 at POS and store
- **WHEN** the seeded `SAVE10` (10%) code is applied to a paid-channel cart in either POS or
  the online store
- **THEN** discount_cents equals 10% of the eligible subtotal and tax is computed on the
  discounted amounts.

### Requirement: Sell-surface product feed

`GET /api/catalog/sellable?channel=pos|web` SHALL return active products with resolved
prices, tax rates, and (for event-linked products) enough info for the caller to pick a
session — this is the single feed both POS and the online store render from.

#### Scenario: One source of truth
- **WHEN** a manager changes a price
- **THEN** the next POS reload and store reload both show the new price with no other edits.
