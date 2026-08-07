# menu-builder (delta)

## ADDED Requirements

### Requirement: Terminal registry and menu assignment

The menu builder SHALL manage named terminals (create, rename, deactivate) and allow
assigning a menu to each terminal. A POS session SHALL be able to claim a terminal
identity (manager-switchable, persisted client-side). `getActiveMenu(db, terminal?)`
SHALL return the assigned menu for a claimed terminal; with no terminal argument, or for
terminals without an assignment, it SHALL return exactly what it returns today (single
active menu), preserving the frozen zero-argument contract. POS sessions with no menu
resolved at all keep the auto-grid fallback.

#### Scenario: Café terminal gets the café menu
- **WHEN** terminal "Café" is assigned the Food menu and a POS claims "Café"
- **THEN** that POS renders the Food menu while an unclaimed POS still renders the
  default active menu.

#### Scenario: Unassigned terminal falls through
- **WHEN** a POS claims a terminal that has no menu assignment
- **THEN** menu resolution behaves exactly as before this change (active menu, then
  auto-grid).
