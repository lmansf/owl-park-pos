# reporting (delta)

## ADDED Requirements

### Requirement: Per-line refund reporting

Sales reports and the chart-of-accounts daily journal SHALL reflect partial refunds at
line granularity: income reversal against each refunded product's account mapping, tax
reversal per tax group, and the day's journal SHALL still balance (debits = credits)
over any mix of sales, partial refunds, and exchanges.

#### Scenario: Journal balances over a partial refund
- **WHEN** a day contains a 3-line sale and a 1-line partial refund
- **THEN** the journal for that day balances and the refunded product's income account
  shows the net of the two.
