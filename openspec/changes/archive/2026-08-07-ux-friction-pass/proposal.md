# Change: ux-friction-pass — loading states, inline validation, keyboard-first flows

## Why

The suite is functionally complete but every high-frequency flow still carries small,
compounding frictions: the POS sell loop is 100% mouse, the store checkout round-trips
the two most common validation errors and shows an inexact "+ tax" total until the
confirmation page, the guest header is hard-coded to the wrong park name, data panes sit
blank during first fetch, a failed login leaves a stale password with no inline error,
and destructive actions are inconsistently confirmed. User priority, verbatim: "Strongly
consider user interfaces, minimal friction, maximum satisfaction."

## What Changes

- **POS keyboard-first selling**: a barcode-wedge/SKU quick-add input above the product
  grid (exact SKU → exact name → unique prefix; misses and ambiguity are announced);
  `Enter` (no field focused) or `F2` opens the tender dialog; inside the dialog the
  cursor lands in the first exact-amount tender row so an exact card sale is
  Enter → Enter; Finalize disables while pending; `Enter` applies the discount code and
  an invalid code shows an inline badge instead of silently clearing; a capacity 409
  highlights the session-bearing cart lines; an empty catalog renders role-aware
  first-run guidance instead of a blank pane.
- **Store checkout hardening**: the details + payment panels become a single `<form>`
  (Enter submits; the disabled-while-submitting button stays the one network guard);
  inline field errors mirror the server checks exactly (name required, email regex, card
  12–19 digits) and clear as they are fixed; cart items carry `tax_rate_bp` so the cart
  computes the exact server total with the shared proportional-discount + per-line-tax
  algorithm ("Estimated total + tax" only remains for stale carts); qty becomes −/+
  steppers (40px targets); a capacity failure deep-links back to the cart's own event
  page; the redundant unit-price column is hidden at phone widths so Remove stays on
  screen.
- **Store brand fix**: the storefront header renders the venue name (cached from
  `/api/store/catalog`, refreshed by pages that fetch it, overridable by the store
  builder's hero title) instead of the hard-coded "AURORA SCIENCE PARK".
- **Admissions**: the gate name persists in localStorage across reloads; a stray tap on
  non-interactive chrome and tab-return both refocus the scan input so a scan is never
  silently eaten.
- **Shared shell**: toasts are click-to-dismiss, errors linger 8s, identical consecutive
  messages collapse; the 401/403 login redirect preserves `location.search`; an
  `op.busy(btn, fn)` helper is the shared disable-while-pending guard; a global
  `:focus-visible` ring makes the new keyboard paths visible; an `.op-skel` skeleton
  class backs loading placeholders.
- **Loading/empty states**: dashboard KPI skeleton tiles; catalog/discounts tables show
  a Loading row (and discounts an empty-state row); POS order search shows "Searching…";
  the storefront grids show "Loading…"; order lookup shows "Looking up…".
- **Forms and confirmations**: failed login shows an inline error, clears and refocuses
  the password; reports validate `from ≤ to` inline and disable Run while pending;
  membership program Delete gains a `confirm()` (server `program_in_use` guard stays the
  enforcement); menu-builder button removal stays confirm-free but its toast says how to
  re-add; event pages selling exactly one product default its qty to 1.

## Non-goals

No new or changed server routes, no authz changes, no DDL, no migration. POS and store
still finalize exclusively through `POST …/finalize` → `pos.finalizeOrder`; keyboard
shortcuts are alternate triggers of the existing handlers. Client-side validation is
additive — server checks remain the enforcement of record. Cart price/tax fields are
display-only; the server reprices from the catalog. No changes to receipt/stub print
CSS, the ticket print flow, or the demo banner.

## Impact

Frontend only: `web/shell.js`, `web/shell.css`, `web/pos.html`, `web/admissions.html`,
`web/login.html`, `web/index.html`, `web/reports.html`, `web/members.html`,
`web/catalog.html`, `web/discounts.html`, `web/menu-builder.html`, `web/store/store.js`,
`web/store/store.css`, `web/store/index.html`, `web/store/event.html`,
`web/store/cart.html`, `web/store/order.html`. Server contracts relied on (all already
tested): `/api/store/catalog` products include `tax_rate_bp` and the response includes
`venue`; checkout 400 codes `name_required`/`email_required`/`bad_card`; finalize 409
codes `capacity`/`no_open_drawer`/`order_not_open`.
