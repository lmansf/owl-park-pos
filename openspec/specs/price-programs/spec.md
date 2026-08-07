# price-programs Specification

## Purpose
TBD - created by archiving change back-office-builders. Update Purpose after archive.
## Requirements
### Requirement: Program management

`web/price-programs.html` (admin/manager) SHALL manage price programs (name, starts_on,
ends_on, priority, active) and each program's per-product override prices (only overridden
products are stored). The list shows which programs are live today.

#### Scenario: Winter pricing
- **WHEN** a manager creates "Winter" covering today with Adult at $24.95 and priority 10
- **THEN** the program shows as live and the Adult override is stored as 2495.

### Requirement: Deterministic resolution

`resolvePrice(db, productId, atIso)` SHALL return the override from the active program
covering the local date of `atIso` with an entry for that product — highest priority wins,
ties broken by lowest program id — or null when no program applies. Date bounds are local
days, inclusive on both ends.

#### Scenario: Overlap resolved by priority
- **WHEN** two live programs both price Adult (priority 10 → 2495, priority 5 → 2295)
- **THEN** resolvePrice returns 2495 with the priority-10 program's name.

### Requirement: Effective prices flow everywhere

Once wired (Phase C), the sellable feed SHALL show the effective price (with
`base_price_cents` and `program_name` when overridden) and order pricing SHALL charge the
effective price for both POS and web channels; reports then reflect charged prices with no
special handling.

#### Scenario: One price in feed, cart, and receipt
- **WHEN** a live program prices Adult at 2495
- **THEN** POS buttons, the store card, the cart line, and the paid order all show 2495,
  and removing the program restores 2995 on the next feed load without restarts.

