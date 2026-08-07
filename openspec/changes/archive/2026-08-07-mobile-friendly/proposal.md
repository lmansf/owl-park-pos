# Change: mobile-friendly — phone-width rendering for store and back office

## Why

The hosted demo is opened from phones (iPhone Safari foremost), and several surfaces
break at phone widths: the POS sell screen's fixed 380px cart column forces horizontal
overflow, five back-office editors use two-column form grids with no fallback, the
item-groups picker demands 560px, wide tables overflow the viewport, and 15px inputs
trigger iOS focus-zoom. Pages already ship viewport meta tags; the CSS just never
had a phone breakpoint.

## What Changes

- Shared shells (`web/shell.css`, `web/store/store.css`) gain a ≤640px breakpoint:
  wide tables become horizontally scrollable in place, inputs bump to 16px (defeats
  iOS focus-zoom), toasts span the viewport, spacing tightens, and top bars respect
  iPhone safe-area insets. `-webkit-text-size-adjust: 100%` pins text scale.
- POS sell screen stacks product grid above cart at ≤900px (same breakpoint its
  button-span rule already uses).
- Form grids in item-config, discounts, price-programs, store-builder (including its
  hero grid), and menu-builder collapse to one column at ≤560px; the item-groups
  picker stacks vertically instead of demanding 560px.

## Non-goals

No markup restructuring, no separate mobile pages, no PWA/manifest work, no
back-office feature changes. Print styling untouched. Desktop rendering unchanged
(all rules live behind max-width media queries).

## Impact

CSS-only plus style blocks in the named pages. No API, module, DDL, or test-visible
behavior changes.
