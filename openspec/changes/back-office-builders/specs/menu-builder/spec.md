# menu-builder (delta)

## ADDED Requirements

### Requirement: Menu designer

`web/menu-builder.html` (admin/manager) SHALL manage menu pages (name, sort, active) and a
button grid per page: each button occupies a `position` slot and is either a product button
(product id; label defaults to product name, price shown) or a page-link button
(link_page_id), with label/color/size overrides. Buttons can be added, edited, moved
(position swap), and removed. A "generate from group" helper fills a page with product
buttons from an item group.

#### Scenario: Two-page menu
- **WHEN** a manager builds page "Tickets" (products) and page "More" with a link button
  back and forth
- **THEN** /api/menus/active returns both pages with their buttons in position order.

### Requirement: POS renders the designed menu

`web/pos.html` SHALL render menu pages as tabs (or a page bar) of positioned buttons from
`GET /api/menus/active`: product buttons add to cart exactly like the old grid (session
picker for event-linked products); link buttons switch pages; inactive products' buttons
are omitted server-side. When NO active menu pages exist, POS falls back to the original
auto-generated grid — the sell flow must never be blocked by menu configuration.

#### Scenario: Fallback preserved
- **WHEN** every menu page is deactivated
- **THEN** the POS shows the auto-grid and selling still works end to end.

#### Scenario: Designed button sells
- **WHEN** a cashier taps a designed Adult button (custom label/color)
- **THEN** the cart lines and totals are identical to the auto-grid path.

### Requirement: Referential safety

Deleting a page with buttons requires confirmation and removes its buttons; a page-link
button whose target page is deleted or inactive is omitted from /api/menus/active.

#### Scenario: No dead links at the terminal
- **WHEN** a linked page is deactivated
- **THEN** the link button no longer appears in the active menu payload.
