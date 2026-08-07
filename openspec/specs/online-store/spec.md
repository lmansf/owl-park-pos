# online-store Specification

## Purpose
TBD - created by archiving change pos-mvp. Update Purpose after archive.
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

#### Scenario: Declined card
- **WHEN** the decline test number is used
- **THEN** the guest sees a payment-declined message, no order is finalized, no tickets
  issued, and capacity is unchanged.

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

