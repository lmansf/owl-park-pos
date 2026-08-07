# pos (delta)

## MODIFIED Requirements

### Requirement: Tender and finalize

Checkout SHALL accept split tenders drawn from the tender registry. Built-in tenders are
`cash` (with change calculation) and `card_sim` (always approves, generates a fake auth
ref); each registry entry declares its method key, label, change behavior, and a
simulated authorize hook. When tenders cover the total, the order is finalized through
the shared posting path: order → paid, tickets issued, capacity counted, audit logged.
Insufficient tender cannot finalize. Adding a tender SHALL NOT require modifying
`finalizeOrder` or any DDL.

#### Scenario: Cash with change
- **WHEN** the total is $43.50 and the cashier enters $50 cash
- **THEN** the order finalizes, change $6.50 is displayed, and a payments row records both
  amounts.

#### Scenario: New tender is additive
- **WHEN** a `voucher` tender is registered and used for an exact-amount payment
- **THEN** the order finalizes through the unchanged posting path and the payments row
  records method `voucher`.

## ADDED Requirements

### Requirement: Tender registry

`GET /api/pos/tenders` SHALL return the active tender list (method, label, change
behavior) for the POS UI to render. `payments.method` SHALL be validated against the
registry rather than a schema CHECK, and chart-of-accounts tender mappings keyed by
method name SHALL apply to registry tenders without accounts-module changes.

#### Scenario: Journal maps a new tender
- **WHEN** a `voucher` payment is taken and a tender mapping exists for `voucher`
- **THEN** that day's journal debits the mapped account and still balances.
