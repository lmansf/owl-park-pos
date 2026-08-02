# webstore-builder (delta)

## ADDED Requirements

### Requirement: Store layout editor

`web/store-builder.html` (admin/manager) SHALL edit the guest store landing layout: hero
settings (title, subtitle, accent color — persisted as `store_*` settings keys) and an
ordered list of sections — kind `products` (hand-picked product ids), `groups` (an item
group), or `html` (rich text block) — with title, sort, active toggle, and live preview
link to /store/.

#### Scenario: Curated landing
- **WHEN** a manager sets hero title "Welcome to Owl Park" and adds sections "Day Tickets"
  (group) and "Go Annual" (the two membership products)
- **THEN** GET /api/store/layout returns the hero settings and both sections with resolved
  product cards in order.

### Requirement: Store renders from layout

`web/store/index.html` SHALL render the landing page from `GET /api/store/layout`: hero
from settings, one section block per active section, product cards identical in behavior
to today's (add to cart, event links). When no sections are configured, the store falls
back to the current static layout — a fresh install must look unchanged.

#### Scenario: Fallback unchanged
- **WHEN** store_sections is empty
- **THEN** the store landing renders the same content as before this change.

### Requirement: Guest safety

`/api/store/layout` is anonymous and SHALL only expose web-channel active products
(resolved server-side through the shared sellable feed); html sections are rendered from
admin-authored content only, and section config is never echoed beyond what the page needs.

#### Scenario: No back-door products
- **WHEN** a pos-only product is hand-picked into a products section
- **THEN** the layout API omits it.
