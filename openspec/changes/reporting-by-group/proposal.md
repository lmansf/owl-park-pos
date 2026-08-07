# Change: reporting-by-group — sales and admissions rollups by item group

## Why

The item-groups spec explicitly anticipated "reporting-by-group later". Groups exist and
drive the menu and store builders, but reports still only slice by product. Operators
think in groups ("how did Food do vs Admissions?"), and the data is already there.

## What Changes

- Sales report gains a group-by-item-group mode: revenue, qty, tax, discounts per group
  (products in multiple groups count in each; ungrouped products roll into "Ungrouped"),
  with the existing date filters and CSV export.
- Admissions report gains the same grouping for admitted tickets (via product → group).
- Dashboard gains a small by-group revenue breakdown for today.

## Non-goals

No new group management UI (item-groups owns that), no nested groups, no allocation
rules for multi-group products beyond count-in-each (flagged in the report footer so
totals-by-group can exceed grand total).

## Impact

`server/modules/reporting.js` (consumes `groups.js` read exports — `listGroups`,
`productIdsInGroup` — per the frozen wave-2 contract), `web/reports.html`,
`web/index.html` dashboard tile. No DDL.
