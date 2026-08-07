# online-store Specification

## Purpose
Guest web store: anonymous storefront where visitors browse tickets and memberships,
check out with simulated payment, and receive their codes — all posting through the same
`pos.finalizeOrder` path as the desk POS.
## Requirements
### Requirement: Anonymous guest storefront

`web/store/` SHALL be a guest-facing storefront (no login, lighter branding than back
office): landing page with venue info, ticket list, event pages with a date picker and
session availability (remaining counts / sold-out badges), and a persistent cart (localStorage).
All store APIs live under `/api/store/*` and require no session.

#### Scenario: Browse availability
- **WHEN** a guest opens the Planetarium page and picks a date
- **THEN** that day's sessions render with remaining seats, sold-out sessions unbuyable.

### Requirement: Checkout with simulated payment

Checkout SHALL capture name + email, apply optional discount codes, show an order summary
with tax, and take a simulated card form (any well-formed number approves; a designated test
number `4000 0000 0000 0002` declines to exercise the failure path). Successful payment
posts the order through the shared posting path with channel `web`.

The details and payment fields SHALL live in a single form so Enter submits from any
field, with the disabled-while-submitting pay button as the one network guard. Client
validation SHALL mirror — never replace — the server checks (name non-empty, the same
email regex, card 12–19 digits after stripping spaces/dashes) as inline per-field errors
that appear on submit/blur, clear as they are fixed, and focus the first invalid field.
When every cart item carries its tax rate, the summary SHALL show the exact tax and
total computed with the shared proportional-discount + per-line-tax algorithm, equal to
the amount the server charges; carts with items missing a rate fall back to
"Estimated total … + tax". Cart-stored price/tax fields are display-only — the server
reprices every line from the catalog. A declined card refocuses the card field; a
capacity failure links back to the event page of the cart's session items (when they
share one event) so the guest can pick another showtime in one tap.

#### Scenario: Declined card
- **WHEN** the decline test number is used
- **THEN** the guest sees a payment-declined message, no order is finalized, no tickets
  issued, and capacity is unchanged.

#### Scenario: Displayed total is the charged total
- **WHEN** a guest with a session ticket in the cart reaches the payment panel
- **THEN** the summary's Tax and Total equal the confirmation page's Tax and Total paid
  to the cent.

#### Scenario: Bad email never round-trips
- **WHEN** a guest submits with an empty name and a malformed email
- **THEN** both fields show inline errors, the first invalid field is focused, and no
  request is sent; fixing a field clears its error immediately.

### Requirement: Confirmation and print-at-home tickets

A successful order SHALL show a confirmation page (order `W-XXXXXXXXX`) listing each ticket
with its Code 39 barcode, session details, and validity — print-styled one ticket per page.
The confirmation is retrievable later at `/store/order.html?code=W-…&email=…` (both must
match).

#### Scenario: Lost tab recovery
- **WHEN** a guest re-opens the order URL with the right order code and email
- **THEN** their tickets render again; a wrong email yields a not-found error, not data.

### Requirement: Same rules as POS

The store SHALL reuse the shared sellable feed, availability API, discount validation, and
posting path — a price/tax/discount/capacity rule can never differ between channels.

#### Scenario: Capacity shared with POS
- **WHEN** POS sells the last seats of a session while a web guest has them in cart
- **THEN** the guest's checkout fails with a capacity error and invites picking another
  session.

### Requirement: Phone-width storefront rendering

The guest store SHALL render without horizontal page overflow at phone widths (~390px):
the product grid falls to one column, the cart table scrolls within its own bounds, the
hero scales down, tap targets remain touch-sized, and the top bar respects device
safe-area insets. Print-at-home ticket styling SHALL be unaffected.

#### Scenario: Checkout on an iPhone
- **WHEN** a guest browses, picks a session, and checks out at a 390px-wide viewport
- **THEN** every step renders within the viewport width with no horizontal page scroll.

### Requirement: Venue-branded storefront chrome

The storefront header brand SHALL render the venue name (from `/api/store/catalog`
`venue`, cached client-side so pages that do not fetch the catalog still show it, and
overridable by the store builder's hero title), falling back to "Owl Park". No page may
hard-code a different venue string.

#### Scenario: Renamed venue propagates
- **WHEN** the venue setting is "Aurora Science Park" and a guest opens the landing page
  and then the cart
- **THEN** both headers read AURORA SCIENCE PARK — the cart from the cached value,
  without its own catalog fetch.

### Requirement: Low-friction cart editing

Cart quantities SHALL be edited with −/+ steppers (≥40px targets, bounds 1–20, remove
via the ✕ control). At phone widths the redundant unit-price column is hidden so the
stepper and Remove stay on screen without horizontal table scrolling. An event page that
sells exactly one product SHALL default its quantity to 1 so pick-a-showtime → Add to
cart succeeds on the first tap.

#### Scenario: One-tap timed-entry add
- **WHEN** a guest picks a showtime for an event with a single ticket product and taps
  Add to cart
- **THEN** one ticket is added without first editing a quantity field.

