# Change: back-office-builders — standalone editors for Owl Park POS

## Why

The MVP proved the sales/admission loop, but configuration lives in cramped side panels
(products in a modal, discounts as a card on the catalog page) and two surfaces are not
configurable at all (the POS button grid and the web store layout are hardcoded). Real
attractions back offices give each concern a standalone editor. This change adds them.

## What Changes

Six new capabilities, each a standalone back-office editor plus its data plane:

- **item-config** — full-page item editor (`/item-config.html?id=`) covering every product
  attribute plus group membership, price-program overrides (read-only view), and account
  mapping; a standalone **discounts editor** (`/discounts.html`) moves discounts off the
  catalog page.
- **item-groups** — named product groups (sort, color) with product assignment; consumed by
  the menu builder, the webstore builder, and reporting-by-group later.
- **menu-builder** — POS touchscreen designer: pages of positioned buttons (product or
  page-link, label/color/size). The POS sell screen renders the designed menu, with the old
  auto-grid as fallback when no menu exists.
- **webstore-builder** — guest store layout editor: hero settings and ordered sections
  (products, groups, custom HTML). The store landing page renders from this layout, with
  the current static layout as fallback.
- **chart-of-accounts** — GL account list and mappings (products, tax groups, tenders,
  discounts → accounts), plus a balanced daily journal report with CSV export.
- **price-programs** — date-ranged price lists with priority (seasonal/promo pricing);
  effective prices flow through the sellable feed and order pricing everywhere.

## Non-goals

Per-terminal menu assignment, multi-currency, GL export formats (just CSV), image/media
management for the store builder, and price-program approval workflows.

## Impact

New tables via core migration `003_builders.sql` (core-owned DDL, as before). New nav
entries. One cross-cutting integration: order pricing consults price programs — wired in
the integration phase through a single `pricing.resolvePrice` contract.
