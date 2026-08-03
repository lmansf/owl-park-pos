# Owl Park Point of Sale

The full **attractions ticketing suite** for the fictional Owl Park — point of sale, gate
admissions, memberships, timed events with capacity, a guest web store, and reporting.
Built as a self-contained demo/learning project: one process, zero dependencies, fully
offline.

## Run

```sh
node server/main.js
# back office: http://localhost:4650  (admin/admin, manager/manager, cashier/cashier, gate/gate)
# guest store: http://localhost:4650/store/
```

Requires Node 22+ (built-in `node:http` + `node:sqlite`); nothing to install. The database
is a SQLite file at `data/owlpark-pos.db` — delete it for a fresh demo reseed.

## Tests

```sh
node --test           # unit/module tests (tests/*.test.js)
node tools/smoke.js   # end-to-end business loop against a scratch DB/server
```

## Design

Spec-driven via OpenSpec: see `openspec/changes/` for each change's proposal, design (module
boundaries and frozen cross-module contracts), per-system spec deltas, and tasks —
`pos-mvp` (the core suite) and `back-office-builders` (standalone editors: item config,
item groups, POS menu builder, webstore builder, discounts, chart of accounts, price
programs). The short
version: every module under `server/modules/` owns its routes and exports a small contract;
orders are finalized through one shared posting path (`pos.finalizeOrder`), and every gate
decision goes through one shared validation path (`admissions.checkCode`).

Demo only: payments are simulated and auth is demo-grade — do not expose beyond localhost.
