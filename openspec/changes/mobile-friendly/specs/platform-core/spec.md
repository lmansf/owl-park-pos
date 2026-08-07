# platform-core (delta)

## ADDED Requirements

### Requirement: Phone-width back-office rendering

Back-office pages SHALL render without horizontal page overflow at phone widths
(~390px): wide data tables scroll horizontally within their own bounds, multi-column
form and layout grids collapse to a single column, and form controls use a 16px font
size on small screens so iOS Safari does not zoom on focus. Desktop layout SHALL be
unchanged (small-screen rules apply only below their breakpoints).

#### Scenario: POS sell screen on a phone
- **WHEN** the POS sell screen is opened at a 390px-wide viewport
- **THEN** the product grid and cart stack vertically and no element forces the page to
  scroll horizontally.

#### Scenario: Report table on a phone
- **WHEN** a report with many columns is viewed at phone width
- **THEN** the table scrolls horizontally inside its own container while the page body
  does not.
