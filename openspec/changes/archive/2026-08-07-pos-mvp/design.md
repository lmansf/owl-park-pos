# Design — pos-mvp

## Stack (decided)

- **Runtime:** Node 22, zero npm dependencies. `node:http` for the server, `node:sqlite`
  (`DatabaseSync`) for storage, `node:crypto` for password hashing (scrypt) and tokens.
- **Frontend:** hand-written HTML/CSS/vanilla JS served statically. No CDN, no build step,
  no web fonts — the whole app must work with networking disabled.
- **DB:** single SQLite file `data/owlpark-pos.db` (gitignored). WAL mode. All money in integer
  cents. All timestamps ISO-8601 UTC strings.
- **Port:** 4650. Start: `node server/main.js` (or `npm start`, which just runs that).

## Layout

```
server/
  main.js            entry: opens DB, runs migrations, mounts modules, listens :4650
  core/db.js         DatabaseSync handle, migration runner (server/migrations/*.sql)
  core/http.js       tiny router: register(method, pattern, handler), JSON body parsing,
                     cookie parsing, sendJSON/sendError, static file serving from web/
  core/auth.js       sessions table, scrypt password hash, login/logout endpoints,
                     requireRole(handler, roles) wrapper
  core/seed.js       idempotent demo seed (venue, products, schedules, users, events)
  modules/<name>.js  one file per capability; exports mount(router) registering /api/<name>/*
server/migrations/   NNN_<name>.sql, applied in order, recorded in schema_migrations
web/
  shell.css shell.js shared back-office chrome (top nav, fetch helper, toast, modal)
  index.html         dashboard (reporting)
  pos.html admissions.html catalog.html events.html members.html reports.html
  store/             guest-facing store (own lighter chrome, no auth)
  lib/barcode.js     Code 39 SVG renderer (shared by POS receipts, store tickets, members)
tools/smoke.js       end-to-end smoke script hitting the HTTP API
tests/<name>.test.js node:test per module, run with `node --test tests/`
```

## Shared contracts (fixed — teams must not change these unilaterally)

### HTTP/API conventions
- All APIs are `"/api/<module>/..."`, JSON in/out. Errors: `{error: "code", message}` with
  4xx/5xx. Auth: cookie `opsid`; unauthenticated API calls → 401; missing role → 403.
- Roles: `admin`, `manager`, `cashier`, `gate`. Store endpoints under `/api/store/*` are
  anonymous.
- Router pattern syntax: `/api/catalog/products/:id` — params in `req.params`, query in
  `req.query`, parsed JSON body in `req.body`, session user in `req.user`.

### Core tables (owned by platform-core migrations 001–003)
- `users(id, username UNIQUE, pass_hash, display_name, role, active)`
- `sessions(sid, user_id, created_at, expires_at)` — retained in schema; sessions are stateless signed cookies since the Vercel deployment (see core/auth.js)
- `settings(key PRIMARY KEY, value)`
- `audit_log(id, at, user_id, action, detail)`

### Domain tables (ALL created by platform-core migration `002_domain.sql`; the module in
parens owns the rows/logic, and teams write NO DDL — this avoids parallel migration-number
collisions)
- (catalog) `products(id, sku UNIQUE, name, kind CHECK(kind IN
  ('ticket','membership','addon')), price_cents, tax_group_id, event_id NULL,
  membership_program_id NULL, validity_days, max_uses, active)`
- (catalog) `tax_groups(id, name, rate_bp)`; `discounts(id, code UNIQUE, name, kind
  CHECK(kind IN('percent','amount')), value, active)`
- (events) `events(id, name, active)`; `event_sessions(id, event_id, starts_at, ends_at,
  capacity, sold INTEGER DEFAULT 0)` — `sold` is maintained transactionally by order posting.
- (pos) `orders(id, channel CHECK(channel IN('pos','web')), status CHECK(status IN
  ('open','paid','void','refunded')), cashier_id NULL, customer_name, customer_email,
  subtotal_cents, tax_cents, discount_cents, total_cents, created_at, paid_at)`
- (pos) `order_lines(id, order_id, product_id, description, qty, unit_price_cents,
  tax_cents, line_total_cents, event_session_id NULL)`
- (pos) `payments(id, order_id, method CHECK(method IN('cash','card_sim')), amount_cents,
  change_cents, ref, created_at)`
- (pos) `tickets(id, code UNIQUE, order_line_id, product_id, event_session_id NULL,
  status CHECK(status IN('valid','used','void')), uses_remaining, valid_from, valid_to,
  holder_name)`
- (membership) `membership_programs(id, name, duration_days, price_cents, benefits)`;
  `members(id, member_no UNIQUE, name, email, program_id, pass_code UNIQUE, joined_at,
  expires_at, status)`
- (admissions) `admits(id, at, code, kind CHECK(kind IN('ticket','member')), ticket_id NULL,
  member_id NULL, gate, result CHECK(result IN('ok','denied')), reason NULL)`

Cross-module writes go through exported functions, not raw SQL into another module's tables:
- `posting.finalizeOrder(db, orderId, payments)` (pos) — validates capacity, increments
  `event_sessions.sold`, issues `tickets` rows, marks order paid. The online store MUST call
  this, so web and POS orders share one posting path.
- `admission.checkCode(db, code, gate)` (admission-control) — decides ok/denied for ticket
  AND member codes, writes `admits`. The POS "verify ticket" screen and gate simulator both
  use it.

### Codes
- Ticket codes: `T-` + 10 uppercase base32 chars (crypto random). Member pass codes: `M-` +
  10. Order confirmation numbers: `W-` + nine chars (web) / `P-` + nine chars (pos).
- Barcodes rendered as Code 39 (charset fits: A–Z, 0–9, dash) via `web/lib/barcode.js`.

### Seed (idempotent, runs when DB empty)
Venue "Owl Park". Users: `admin/admin`, `manager/manager`, `cashier/cashier`,
`gate/gate`. Tax group 6.25%. Products: adult/child/senior day tickets, parking addon,
planetarium timed-entry ticket (linked to event), 2 membership programs. Planetarium event
with sessions every 90 min for the next 14 days, capacity 40. One demo discount `SAVE10`.

## Sequencing

1. **Phase A (serial):** platform-core lands first — server skeleton, router, auth, migration
   runner, core migrations, seed, app shell, barcode lib stub. Everything else builds on it.
2. **Phase B (parallel teams):** catalog-pricing + events-capacity (data plane), then pos,
   membership, admission-control, online-store, reporting. Each team = builder + verifier.
   POS owns the shared posting path; online-store consumes it. Admission-control owns
   checkCode; POS/membership consume it.
3. **Phase C (serial):** integration pass — smoke script exercising sell→scan→report and
   web-order→will-call→admit, fix findings, final review.

## Risks / open challenges — ratified 2026-08-02

All four defaults below were confirmed by the captain in the Lavish plan review
(mock tender; barcode SVG + wedge entry + gate simulator; full refund only; all 8 systems).

1. Payments are simulated — is a mock card tender acceptable long-term, or should a
   pluggable tender interface be specced now? (MVP: mock with pluggable `method` enum.)
2. Hardware emulation — barcode SVG + typed entry stands in for scanners/printers. Webcam
   scanning and ESC/POS printing are out of scope.
3. Capacity contention — SQLite single-writer keeps oversell risk low locally, but posting
   uses a transaction with a `sold < capacity` guard as the real defense.
4. Auth realism — plain cookie sessions, seeded demo passwords, no lockout/2FA. Fine local,
   must be revisited if ever exposed.
5. Refunds/exchanges are modeled minimally (order → refunded, tickets → void); no partial
   refunds in MVP.
