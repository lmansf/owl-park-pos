# Change: drawer-sessions-zreports — cash-drawer sessions, blind close, Z-reports

## Why

Cash is the only tender the system takes that leaves no accountability trail: any
cashier can take cash all day with no float, no count, and no reconciliation against
`payments`. The production roadmap (§5, cash controls) calls for per-station drawer
sessions — open float, paid-in/out, blind close with over/short — plus Z-reports and a
manager-facing reconciliation report. Nothing of the kind exists yet.

## What Changes

- New `server/modules/drawer.js`: drawer sessions keyed by **cashier** (one open
  session per user, enforced in the app and by a partial unique index), an immutable
  paid-in/paid-out movement ledger, blind close (counted cash in, expected/over-short
  computed inside the close tx, sequential `z_number` out), and per-session Z-reports
  (JSON + CSV) in the uniform report sections shape. Exports `openSessionFor`,
  `closeSession`, `zReport` as the cross-module seam.
- `pos.finalizeOrder` (inside its existing tx): POS-channel payments are stamped with
  the cashier's open drawer session; a cash-bearing POS finalize with no open drawer
  fails 409 `no_open_drawer` with full rollback. Card-only POS finalizes stay allowed
  (stamped when a drawer is open, NULL otherwise). Web-channel orders never require a
  drawer. The frozen `finalizeOrder(db, ctx, orderId, payments)` signature is unchanged.
- `pos.refundOrder`: negative payment rows are stamped with the *acting* user's open
  drawer (cash refunds net out of that drawer's expected); refunds never require one.
- `server/modules/reports.js`: fifth report `GET /api/reports/drawers` — closed
  sessions per local day plus an "Unattributed POS cash" cross-check line (0 once
  enforcement is live). `parseRange`/`toCsvRows` are additively exported for drawer.
- New DDL in `server/migrations/904_drawer-sessions-zreports.sql` (core-owned):
  `drawer_sessions`, `drawer_movements`, and `payments.drawer_session_id`.
- UI: a Drawer dialog on `web/pos.html` (open-with-float presets, movements, blind
  close, printable Z on the receipt paper pattern; a `no_open_drawer` failure opens the
  dialog directly) and a "Drawer sessions" tab on `web/reports.html`.
- Blind-close discipline throughout: no cashier-visible pre-close response carries
  expected cash or any derived cash sum, and paid-outs are capped only statically so
  validation errors cannot become a balance oracle.

## Non-goals

No hardware drawer kick. No multi-drawer-per-user or shared drawers. No terminal
identity — drawers key on the cashier; a display-only `terminal` label is stored for
forward compatibility with per-terminal-menus, which explicitly defers per-terminal
reporting. No partial-day X-reports. No change to the two invariant chokepoints beyond
attribution inside `pos.finalizeOrder`; drawer.js never writes `payments` rows.

## Impact

New module + migration + report + two UI surfaces; `server/modules/pos.js` (two touch
points inside existing txs), `server/modules/reports.js` (report + additive exports),
`web/pos.html`, `web/reports.html`, `tests/drawer.test.js`, drawer-open setup in
existing cash-finalizing tests (pos/store/reports/accounts), smoke drawer section.
Zero npm dependencies; all money integer cents.
