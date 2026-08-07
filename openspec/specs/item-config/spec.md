# item-config Specification

## Purpose
Standalone per-product editor: a single page that edits every attribute of one product
(identity, pricing, tax, availability, grouping) without leaving the item's context.
## Requirements
### Requirement: Standalone item editor

`web/item-config.html?id=<product>` (admin/manager) SHALL edit every product attribute on a
full page (SKU, name, kind, price, tax group, linked event, membership program, validity,
max uses, channels, active), show and edit the item's group memberships (via the groups
API), show any price-program overrides affecting it (read-only, via the pricing API when
present), and show/edit its income-account mapping (via the accounts API when present).
Opening with no `id` creates a new item. Saving returns to the catalog list.

#### Scenario: Everything about one item in one place
- **WHEN** a manager opens item-config for the seeded Adult Day Ticket
- **THEN** they see and can change its price/tax/channels, toggle its groups, and see any
  active program override with the program name — without visiting another page.

### Requirement: Catalog page slims down

`web/catalog.html` SHALL become a products list (search/filter, active toggle) whose rows
link to item-config; the modal editor and the embedded discounts/tax cards are removed
(tax groups stay on catalog.html; discounts move to their own page).

#### Scenario: Row click edits
- **WHEN** a manager clicks a product row
- **THEN** item-config opens for that product.

### Requirement: Standalone discounts editor

`web/discounts.html` (admin/manager) SHALL list discount codes with create/edit/deactivate
(code, name, percent|amount, value, active) using the existing `/api/catalog/discounts`
endpoints (extended as needed, contract-stable).

#### Scenario: Deactivate stops redemption
- **WHEN** a manager deactivates SAVE10 and a cashier applies it
- **THEN** the POS shows the standard invalid-code error.

### Requirement: Contract stability

`catalog.js` SHALL keep every existing export and route shape intact (additive changes
only): `getSellable`, `validateDiscount`, sellable/validate routes, product CRUD.

#### Scenario: Old consumers unaffected
- **WHEN** the full test suite runs after this change
- **THEN** all pre-existing catalog, pos, and store tests still pass unmodified.

