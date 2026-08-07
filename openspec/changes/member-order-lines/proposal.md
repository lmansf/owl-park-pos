# Change: member-order-lines — structured member references on order lines

## Why

Membership info on order lines is text-encoded in the line description ("(renewal #N)" /
"(for Name <email>)") because `order_lines` has no member column; `pos.js` writes the
text and `store.js` parses it back. CLAUDE.md flags this as the repo's sharpest edge:
the two sides must change in lockstep, and any description edit (or future localization)
silently breaks membership fulfillment.

## What Changes

- Core migration adds nullable structured columns to `order_lines`:
  `member_id` (existing member, for renewals) and `member_intent` JSON
  (name/email for a new member to create at finalize).
- `pos.js` and `store.js` write/read the structured columns; the description becomes
  display-only text with no parsing anywhere.
- Best-effort backfill of existing rows from the legacy description format, keeping
  historical orders queryable the new way.
- Membership posting logic in `finalizeOrder` consumes the columns instead of parsing.

## Non-goals

No change to membership products, pricing, pass codes, or the gate path. No new UI —
the POS and store already collect the same data; only its transport changes.

## Impact

Migration (core-owned DDL), `server/modules/pos.js`, `server/modules/store.js`,
membership tests. Removes the documented sharp edge from CLAUDE.md once archived.
