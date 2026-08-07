# reporting (delta)

## ADDED Requirements

### Requirement: Group rollups

The sales and admissions reports SHALL support grouping by item group over the standard
date filters: per-group revenue/qty/tax/discounts (sales) and admit counts (admissions),
resolved through the item-groups read exports. Products in multiple groups SHALL count
in each group, ungrouped products SHALL appear under "Ungrouped", and the report SHALL
disclose that multi-group membership can make group totals exceed the grand total. CSV
export SHALL be available in group mode.

#### Scenario: Food vs Admissions day
- **WHEN** the sales report is grouped by item group for today
- **THEN** each group row shows its revenue and the Ungrouped row absorbs products in no
  group.

#### Scenario: Multi-group disclosure
- **WHEN** a product belonging to two groups sells once
- **THEN** both group rows include it and the report footer notes the double-count rule.
