# Tasks — drawer-sessions-zreports

## Phase A — schema + module

- [x] A1 `server/migrations/904_drawer-sessions-zreports.sql`: `drawer_sessions`
      (+ partial unique index on open-per-user), `drawer_movements`,
      `payments.drawer_session_id` + index (placeholder 9NN; coordinator renumbers)
- [x] A2 `server/modules/drawer.js`: `openSessionFor` seam, open (409
      `drawer_already_open`), movements (immutable, statically capped — no balance
      oracle), blind `closeSession` (expected/over-short/z_number computed in-tx),
      `zReport` (uniform sections: cash reconciliation, payments-by-method,
      movements); routes open/current/movements/close (SELL, own-session only),
      sessions list + force-close (MANAGERS), Z (managers or owner, 404 for others,
      CSV via reports.toCsvRows); audit on every mutation

## Phase B — posting-path + report wiring

- [x] B1 `server/modules/pos.js` finalizeOrder: in-tx drawer resolution for POS
      channel, 409 `no_open_drawer` when cash and none open, payments INSERT stamps
      `drawer_session_id`, audit detail carries it (signature unchanged; web path
      untouched)
- [x] B2 `server/modules/pos.js` refundOrder: negative rows stamped with the acting
      user's open drawer, else NULL; never required
- [x] B3 `server/modules/reports.js`: `drawersReport` + `GET /api/reports/drawers`
      (MANAGERS) with Unattributed POS cash section; additive exports `parseRange`,
      `toCsvRows`

## Phase C — UI

- [x] C1 `web/pos.html`: Drawer button + dialog (float presets $100/$150/$200, paid
      in/out with required reason, blind close with counted-only input), printable Z
      on the receipt paper pattern, `no_open_drawer` finalize failure opens the
      dialog; usable at 390 px (op-modal + tender-row patterns)
- [x] C2 `web/reports.html`: "Drawer sessions" tab riding the generic renderer;
      text-column alignment for cashier/terminal/item

## Phase D — verification

- [x] D1 `tests/drawer.test.js`: lifecycle + double-open 409 + schema backstop,
      validation (strict integer cents, kind/reason, ids), cash-without-drawer 409
      with rollback proof, card-only pinned allowed, web-channel exemption,
      attribution (cash + card + refund), blind-state assertions (no `expected` in
      any pre-close cashier response; Z of open session 409), close math and Z
      sections, immutability, IDOR probe (cross-user Z → 404), force-close audit
      `forced`, paid-out oracle guard, XSS payload as data, sessions list, drawers
      report + unattributed line + CSV, authz matrix (401/403 per route)
- [x] D2 update cash-finalizing suites to open a drawer in setup: `tests/pos.test.js`,
      `tests/store.test.js`, `tests/reports.test.js`, `tests/accounts.test.js`
- [x] D3 `tools/smoke.js`: no-drawer 409 → open drawer → sell flow → paid-out →
      blind close → Z math + payments-by-method equality vs DB → manager drawer
      absorbs the refund → drawers report totals + unattributed 0 + CSV
