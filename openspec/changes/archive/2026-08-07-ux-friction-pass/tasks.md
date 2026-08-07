# Tasks — ux-friction-pass

## Phase A — shared shell (serial; every page rides it)

- [x] A1 shell.js: toast click-to-dismiss, 8s err duration, collapse identical
      consecutive messages; 401/403 redirect preserves path + search; `op.busy` helper
- [x] A2 shell.css: global `:focus-visible` ring, `.op-skel` skeleton, toast cursor

## Phase B — POS keyboard-first

- [x] B1 Quick-add input above the grid: exact SKU → exact name → unique prefix via the
      existing `tapProduct` path; miss/ambiguity toasts
- [x] B2 Enter (no field focused) / F2 open tender; Enter in a tender row adds that
      tender; Enter elsewhere finalizes when enabled; focus lands in the first
      exact-amount row on open and follows the flow across re-renders
- [x] B3 Double-submit guards: `op.busy` on order create and finalize
- [x] B4 Discount: Enter applies; invalid code shows an inline err badge, code kept for
      correction
- [x] B5 Capacity 409 on finalize highlights session cart lines (cleared on next edit)
- [x] B6 Loading state for the product pane; role-aware empty-catalog guidance;
      "Searching…" row in order search

## Phase C — store checkout

- [x] C1 cart.html: single `<form>` submit path; inline errors mirroring server checks
      (name / email regex / card 12–19 digits), clear-on-fix, focus first invalid;
      disabled-while-submitting unchanged as the sole network guard
- [x] C2 Exact totals: `tax_rate_bp` stored at both `cartAdd` call sites; POS
      proportional-discount + per-line-tax mirror in `estimate()`; "+ tax" fallback for
      stale carts
- [x] C3 Qty −/+ steppers (40px); phone width hides the unit-price column so Remove
      stays visible
- [x] C4 Capacity error deep-links to the cart's own event page (`event_id` on items);
      declined card refocuses the card field; discount Enter applies
- [x] C5 Brand: header venue name from cached `/api/store/catalog` `venue` (setVenue on
      catalog fetches; hero title override; "Owl Park" fallback) — replaces hard-coded
      AURORA SCIENCE PARK
- [x] C6 event.html: default qty 1 when the event sells one product; storefront grids
      get Loading placeholders; order lookup gets a Looking-up state

## Phase D — back office polish

- [x] D1 login.html: inline "wrong username or password" recovery — clear + refocus
      password (lockout hint unchanged)
- [x] D2 index.html: KPI skeleton tiles pre-fetch
- [x] D3 reports.html: `from ≤ to` inline validation; Run busy-guarded; failure message
      instead of a blank pane
- [x] D4 members.html: program Delete confirm (server `program_in_use` stays the guard)
- [x] D5 admissions.html: gate persisted to localStorage (input event); scan refocus on
      background click and visibilitychange
- [x] D6 catalog/discounts: Loading rows; discounts empty-state row; menu-builder remove
      toast explains re-add

## Phase E — verification (serial)

- [x] E1 `node --test` green (371 pass); `tools/smoke.js` green (97 checks)
- [x] E2 Browser pass via chrome-devtools-axi at 1280px and 390×844 on every touched
      page: keyboard-only POS sale (SKU, Enter, F2, Enter, Enter → paid receipt);
      failed-login recovery; gate persistence + refocus; reports range validation;
      program-delete confirm copy; store add→event→cart→checkout with exact total
      matching the charged total; mobile cart/steppers/tender dialog fit
