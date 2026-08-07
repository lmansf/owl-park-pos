# Owl Park Point of Sale — user guide

A page-by-page tour of the suite. Everything below assumes the demo seed: venue **Owl
Park**, four demo users, a Planetarium Show with timed sessions, day tickets, parking, two
membership programs, and discount code `SAVE10`.

## Signing in and roles

Back office: `http://localhost:4650` (hosted demos: the deployment URL). Demo accounts:

| Username / password | Role | Sees |
| --- | --- | --- |
| `admin` / `admin` | admin | everything, including tax rates, account edits |
| `manager` / `manager` | manager | everything except admin-only edits |
| `cashier` / `cashier` | cashier | Dashboard, POS, Admissions, Members, Help |
| `gate` / `gate` | gate | Admissions (and Help) only |

The guest **web store** at `/store/` needs no login.

> Hosted demo note: when a yellow banner says the database is ephemeral, every cold start
> reseeds the demo data — explore freely, nothing you change is kept.

## Back office pages

### Dashboard (`/index.html`)
Today at a glance: revenue, orders, tickets sold, admits (with denial count), active
members, and the next sessions with a fill meter. Auto-refreshes every minute.

### POS (`/pos.html`)
The selling screen. Left side: your **designed menu pages** (from the Menu builder) as
tabs of buttons — or, if no menu is configured, an automatic grid of all sellable items
grouped by kind. Tap items to add to the cart; event-linked items (Planetarium) open a
session picker showing remaining seats. Right side: the cart — quantities, discount code
box, running totals (on phone-width screens the menu stacks above the cart). **Tender** opens the payment modal: cash (quick-bill buttons, change
calculated) and/or simulated card; split tenders are fine. Finalizing shows the receipt
and one printable stub per ticket, barcode included (browser print gives one ticket per
page). Selling a **membership** prompts for the member's name/email, or search-and-attach
an existing member to renew. **Order search** (top of page) finds past orders by
confirmation or customer; any seller can void open orders or refund paid ones (full
refund: tickets void, seats released), but each void/refund asks a manager or admin to
type their own credentials as approval — the audit log records both people.

### Admissions (`/admissions.html`)
The gate. The big input is keyboard-wedge friendly: scan or type a ticket (`T-…`) or
member pass (`M-…`) code and press Enter — a full-panel green OK or red DENIED result
shows the holder and, when denied, the machine reason (`expired`, `exhausted`,
`wrong_session_time`, `void`, `unknown`, `suspended`). Session tickets admit from 30
minutes before their session start until session end. The page shows today's admit count
and the last scans. Managers/admins also get a **simulator** drawer listing currently
valid tickets and active members for one-click demo scans.

### Catalog (`/catalog.html`) and Item Config (`/item-config.html?id=…`)
Catalog is the searchable product list (with the tax-groups card; rates are admin-only).
Click any row — or "New item" — to open **Item Config**, the full-page editor: SKU, name,
kind (ticket / membership / addon), price, tax group, linked event, membership program,
validity days, max uses, sales channels, active flag; plus the item's **group
memberships**, any live **price-program override** (with program name), and its **income
account** mapping (editable by admins). Items that have sold are deactivated, never
deleted.

### Groups (`/item-groups.html`)
Item groups (name, sort, color) with a two-pane picker to assign products. Groups feed the
Menu builder ("generate from group"), the Store builder (group sections), and Item Config.

### Events (`/events.html`)
Events and their timed sessions. **Bulk generate** creates a session grid (date range,
first/last start time, interval, capacity). The day grid shows sold/capacity with fill
colors. Capacity can be raised anytime; lowering below sold is rejected. Cancelling a
session (manager) voids its tickets.

### Menus (`/menu-builder.html`)
The POS screen designer. Create pages, then place buttons by position: **product buttons**
(custom label, color, size) or **page links** for navigation. "Generate from group" fills
a page from an item group. POS picks the design up immediately; deactivate all pages to
fall back to the automatic grid.

### Store Builder (`/store-builder.html`)
The guest store's landing-page editor: hero title/subtitle/accent color, then ordered
sections — hand-picked products, an item group, or an HTML block. The store renders these
live; with no sections configured it shows its built-in default layout.

### Discounts (`/discounts.html`)
Order-level discount codes: percent or fixed amount, active toggle. Codes apply at POS and
web checkout identically (proportional across lines, before tax).

### Pricing (`/price-programs.html`)
Price programs: named, date-ranged (inclusive, local days), prioritized price lists, each
overriding chosen items' prices. A live program changes the price **everywhere at once** —
POS buttons, store cards, carts, receipts, reports. Overlaps resolve by highest priority.

### Accounts (`/accounts.html`)
The chart of accounts (a default chart self-installs) and mappings: product → income
account, tax group → liability, tender → clearing, discounts → contra account. The
**daily journal** derives balanced debit/credit entries from actual activity — refunds
reverse on their refund date, unmapped revenue lands visibly on the `9999 Unmapped` line.
CSV export included. Note: the journal is derived live from current mappings, not an
immutable ledger.

### Members (`/members.html`)
Search members by name, email, number, or pass code; view/edit details, suspend or
reinstate (manager+), and print the **pass card** with its scannable barcode. Selling or
renewing memberships happens at POS or in the web store; renewals extend the same member
record.

### Reports (`/reports.html`)
Four date-ranged reports, each with a totals row and CSV download: **Sales summary** (by
day and channel; net = gross − discounts), **Product mix**, **Admissions** (scans, admits,
denials by reason, per gate), **Memberships** (sold/renewed, active, upcoming
expirations).

### Backups (`/backups.html`) — admin only
Snapshot list with sizes and triggers, a **Back up now** button, disk-space and
last-backup status, and per-snapshot delete. Snapshots are taken with SQLite's online
backup API — safe while the server is running — and land in `data/backups/`. A scheduled
backup runs every 60 minutes by default; the newest 14 snapshots are kept. Restore is
CLI-only (see the runbook below). On the hosted demo backups are disabled — the database
there is ephemeral by design.

### Help (`/help.html`)
A condensed version of this guide, in-app.

## The guest store (`/store/`)

Landing page (hero + sections from the Store Builder), event pages with a date picker and
live seat availability, cart (kept in the browser), and checkout: name + email, optional
discount code, simulated card — any well-formed number approves; **`4000 0000 0000 0002`
always declines** (for testing the failure path). The confirmation page shows print-at-home
tickets with barcodes, one per page when printed. Lost the tab? `/store/order.html` re-opens
any order with its `W-…` confirmation code plus the checkout email. Memberships bought
online show the printable pass card on the confirmation page.

## Try this end-to-end

1. As `cashier`: sell 2 Adult + a Planetarium session with `SAVE10`, tender $50 cash.
2. As `gate`: scan a ticket stub's code — OK; scan it again — DENIED `exhausted`.
3. In the store: buy a membership, then scan the pass at the gate.
4. As `manager`: refund the first order, watch the seats free up on Events; check
   Reports and the Accounts journal — the day still balances.

## Running and deploying

- **Local:** `node server/main.js` → `http://localhost:4650`. Node 22+, no install. Delete
  `data/owlpark-pos.db` to reseed.
- **Vercel:** the repo deploys as-is (`vercel.json` routes everything through one
  serverless function). The hosted database lives in `/tmp` and is intentionally
  ephemeral — a demo, not a system of record. Real payments and real hardware are out of
  scope by design.
- **Production mode:** set `OWLPOS_MODE=production` and a strong `OWLPOS_SECRET`
  (at least 32 bytes, e.g. 64 hex chars — the server refuses to start without one). In
  this mode the seeded demo accounts must set a real password at first sign-in before
  anything else works, session cookies are marked `Secure` (put the server behind
  HTTPS), and the login page stops advertising demo credentials. In every mode, login is
  rate-limited, five consecutive wrong passwords lock an account for 15 minutes (failed
  attempts land in the audit log), voids/refunds require a manager to enter their own
  credentials, and the Password button in the top bar changes your password — which also
  signs out every other session for the account.

## Backup and restore runbook

- **Where snapshots live:** `data/backups/owlpark-<timestamp>-<scheduled|manual>.db`,
  file mode 0600. Each snapshot is the complete database (including staff password hashes
  and member emails) — copy the folder offsite regularly (`rsync data/backups/ …`) and
  treat the copies as sensitive.
- **Taking one:** the Backups page (**Back up now**) or wait for the scheduler. Tune with
  `settings` keys `backups.interval_min` (0 disables the scheduler) and `backups.retain`,
  or env `OWLPOS_BACKUP_INTERVAL_MIN` / `OWLPOS_BACKUP_RETAIN`.
- **Restoring:** stop the server, then:

  ```
  node tools/restore.js data/backups/<snapshot>.db
  ```

  The tool verifies the snapshot's integrity, refuses snapshots created by newer code
  than this checkout, keeps your current database beside the restored one as
  `owlpark-pos-pre-restore-<timestamp>.db`, and records the restore in the audit log.
  Older snapshots are fine — pending migrations apply on the next start. Use `--db <path>`
  for a non-default database location; `--force` overrides the freshness/name checks.
- **Health:** `/api/health` shows disk-free, database size, and last-backup time to
  signed-in admins/managers; the shell shows a persistent banner when disk is low.
