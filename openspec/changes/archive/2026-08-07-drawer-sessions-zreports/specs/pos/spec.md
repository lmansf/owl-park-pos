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

POS-channel payments SHALL be stamped with the cashier's open drawer session inside the
finalize transaction; a cash-bearing POS finalize with no open drawer for the order's
cashier SHALL fail 409 `no_open_drawer` with the same full-rollback behavior as
`capacity`. Card-only POS finalizes succeed without a drawer (attribution NULL).
Web-channel finalizes never require a drawer. The `finalizeOrder(db, ctx, orderId,
payments)` signature is unchanged — the drawer is resolved internally.

#### Scenario: Cash with change
- **WHEN** the total is $43.50 and the cashier enters $50 cash
- **THEN** the order finalizes, change $6.50 is displayed, and a payments row records both
  amounts.

#### Scenario: New tender is additive
- **WHEN** a `voucher` tender is registered and used for an exact-amount payment
- **THEN** the order finalizes through the unchanged posting path and the payments row
  records method `voucher`.

#### Scenario: Cash without a drawer cannot finalize
- **WHEN** a cashier with no open drawer session finalizes a POS order with any cash
  tender
- **THEN** the response is 409 `no_open_drawer`, the order stays `open` with no
  tickets, payments, or capacity movement, and the POS opens the drawer dialog.
