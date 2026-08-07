# pos (delta)

## MODIFIED Requirements

### Requirement: Touch-first sell screen

`web/pos.html` (roles cashier/manager/admin) SHALL show a button grid of sellable products,
a cart with qty edit/remove, discount code entry, and running subtotal/tax/total. Adding an
event-linked product opens a session picker fed by the availability API. Layout must be
usable at compact touchscreen resolutions with touch-sized targets.

The sell screen SHALL equally support a keyboard-only loop: a quick-add input above the
grid resolves a scanned/typed value by exact SKU, then exact name, then unique
SKU-or-name prefix, and adds through the same `tapProduct` path (session picker and
membership prompt included); a miss or ambiguous prefix is announced via toast, never
silent. `Enter` with no field focused, or `F2` anywhere in the Sell view, triggers the
existing tender action. The product pane SHALL show a loading state before first data
and, when the sellable feed is empty, role-aware first-run guidance (managers get links
to Catalog and Menus; cashiers are told to ask a manager) instead of a blank pane.
Applying a discount SHALL work via Enter, and an invalid code SHALL show inline feedback
while keeping the typed code for correction.

#### Scenario: Sell two adults and a planetarium entry
- **WHEN** the cashier taps Adult ×2 and Planetarium, picks the 14:00 session, and totals
- **THEN** the cart shows 3 lines with correct per-line tax and a grand total.

#### Scenario: Keyboard-only exact-card sale
- **WHEN** a cashier types a SKU and Enter, presses F2, and presses Enter twice in the
  tender dialog
- **THEN** the product is in the cart, the dialog opens with the first exact-amount
  tender row focused and prefilled with the total, the tender is added, and the order
  finalizes through the unchanged `$('tender-finalize')` handler — no mouse required.

#### Scenario: Empty catalog is explained
- **WHEN** the POS loads with no sellable products and no menu pages
- **THEN** the product pane explains there is nothing to sell yet and (for managers)
  links to the Catalog instead of rendering blank.

## ADDED Requirements

### Requirement: Tender dialog pending and recovery states

The tender dialog SHALL disable Finalize while a finalize request is pending (a double
Enter/click never fires the route twice; the server's 409 `order_not_open` remains the
backstop, not the UX). On a capacity 409 the dialog closes and the cart's session-bearing
lines are visually flagged until the cashier edits the cart, alongside the server's
error toast. Keyboard shortcuts SHALL be alternate triggers of the existing handlers —
never a second code path to finalize.

#### Scenario: Double Enter cannot double-finalize
- **WHEN** the cashier presses Enter twice in quick succession on an enabled Finalize
- **THEN** exactly one finalize request is sent; the button is disabled until it settles.

#### Scenario: Session sold out under the cart
- **WHEN** finalize returns 409 `capacity`
- **THEN** the dialog closes, the session lines in the cart are highlighted, and a toast
  tells the cashier to pick a different session or fewer seats.
