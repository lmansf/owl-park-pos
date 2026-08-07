# online-store (delta)

## MODIFIED Requirements

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

## ADDED Requirements

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
