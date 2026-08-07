# Tasks — member-order-lines

## Phase A — core (serial)

- [x] A1 Migration: add `member_id` + `member_intent` to `order_lines`; backfill from
      legacy description formats (best-effort, NULL on no-parse)

## Phase B — one team (builder → verifier)

- [x] B1 pos.js: write structured columns at line add; finalizeOrder consumes them
      (create/renew member) with no description parsing
- [x] B2 store.js: same for web checkout; description becomes display-only
- [x] B3 Tests: renewal, new-member (POS + web), backfilled row, unparseable row;
      smoke covers member sell + renew end-to-end

## Phase C — cleanup (serial)

- [x] C1 Remove the sharp-edge warning from CLAUDE.md; archive this change
