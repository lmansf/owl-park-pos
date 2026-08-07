# online-store (delta)

## ADDED Requirements

### Requirement: Phone-width storefront rendering

The guest store SHALL render without horizontal page overflow at phone widths (~390px):
the product grid falls to one column, the cart table scrolls within its own bounds, the
hero scales down, tap targets remain touch-sized, and the top bar respects device
safe-area insets. Print-at-home ticket styling SHALL be unaffected.

#### Scenario: Checkout on an iPhone
- **WHEN** a guest browses, picks a session, and checks out at a 390px-wide viewport
- **THEN** every step renders within the viewport width with no horizontal page scroll.
