# Change: pos-mvp — Owl Park Point of Sale suite

## Why

The captain wants a local, browser-based attractions ticketing suite for the fictional Owl
Park — to explore how such a system hangs together (POS, admissions, memberships, online
sales, reporting) without any vendor dependency. Everything is designed and written from
scratch in this repo; module names describe functions generically.

## What Changes

Build a self-contained web application, local-only:

- **platform-core** — zero-dependency Node 22 server (`node:http` + `node:sqlite`), SQLite
  database file, migrations + seed data, cookie-session auth with roles, JSON API framework,
  static file serving, back-office app shell.
- **catalog-pricing** — product catalog (PLU-style items), price schedules, tax groups,
  discounts.
- **events-capacity** — timed events/sessions with capacity pools (the "resource" side of an
  attractions system: timed-entry slots, sellable capacity, sold counts).
- **pos** — operator point-of-sale: touch-first sell screen, cart, tenders (cash + simulated
  card), receipt + ticket issuance with scannable codes.
- **admission-control** — gate validation: scan/enter a ticket or pass code, enforce validity
  window / use count / session, record admits, gate simulator UI.
- **membership** — membership programs, member records, sell/renew memberships at POS, member
  passes valid at the gate.
- **online-store** — guest-facing web store: browse date/session availability, cart, checkout
  (simulated payment), order confirmation with print-at-home tickets.
- **reporting** — sales, admissions, and membership reports with date filters; back-office
  dashboard; CSV export.

## Scope / Non-goals

- Local only: one machine, `http://localhost:4650`, SQLite file under `data/`. No cloud, no
  external services, no network calls at runtime, zero npm dependencies.
- Payments are simulated (an approving mock tender). No real payment-processor integration.
- No physical hardware (printers, turnstiles, cash drawers, scanners). Barcodes render as
  Code 39 SVG on tickets; "scanning" is keyboard-wedge-style text entry or the gate simulator.
- Not multi-tenant, not internationalized, not hardened for production exposure.

## Capabilities touched

All eight capabilities above are ADDED (greenfield project).

## Impact

New repository content: `server/`, `web/`, `data/` (gitignored DB), `tools/`, `tests/`.
Each capability is owned by one agent team during implementation; boundaries and shared
contracts are fixed in `design.md` so teams can build in parallel.
