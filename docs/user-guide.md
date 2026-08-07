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
members, and the next sessions with a fill meter. Managers and admins also see a **Sales
by group today** card — order revenue (incl. tax) by item group, top groups plus
Ungrouped. It is sales-based, unlike the payments-based revenue tile, so the two can
differ on days with refunds. Auto-refreshes every minute.

### POS (`/pos.html`)
The selling screen. Left side: your **designed menu pages** (from the Menu builder) as
tabs of buttons — or, if no menu is configured, an automatic grid of all sellable items
grouped by kind. A **terminal chip** at the top right shows which named terminal this
register has claimed (or "Default menu"); managers and admins click it to claim or
switch terminals, and the register then shows only that terminal's assigned menu pages
(see the Menus page below). The claim is remembered per browser, is purely a menu-layout
choice — prices and permissions never change with it — and cashiers see the claimed name
read-only. Tap items to add to the cart; event-linked items (Planetarium) open a
session picker showing remaining seats. The **quick-add box** above the grid is
barcode-wedge friendly: scan or type a SKU (or the start of a name) and press Enter to
add it. The whole sale works keyboard-only — **Enter** (with no field focused) or **F2**
opens the tender dialog with the exact card amount prefilled, so an exact-card sale is
Enter · Enter · Enter. Right side: the cart — quantities, discount code
box, running totals (on phone-width screens the menu stacks above the cart). **Tender** opens the payment modal with one row per configured
tender — cash (quick-bill buttons, change calculated), simulated card, and a demo
voucher (always approves); split tenders are fine. Finalizing shows the receipt
and one printable stub per ticket, barcode included (browser print gives one ticket per
page). Selling a **membership** prompts for the member's name/email, or search-and-attach
an existing member to renew. **Order search** (top of page) finds past orders by
confirmation or customer; any seller can void open orders or refund paid ones — in full
or per line: the refund dialog has a quantity stepper per line (**Select all** for the
classic full refund), refunded tickets void and their session seats free up, and the
money goes back to the original tenders. A partly refunded order shows a `partial
refund` badge and can be refunded again later. On the receipt, each still-valid session
ticket stub offers **Exchange session** — move it to another upcoming session of the
same event with seats left; the old stub voids and a replacement prints. Every void,
refund, and exchange asks a manager or admin to type their own credentials as
approval — the audit log records both people.

**Cash drawer**: the Drawer button (top right) manages your cash-drawer session. Taking
cash requires one — count your opening float and open the drawer first (if you forget,
the failed sale opens the dialog for you). Record paid-ins/paid-outs with a reason as
they happen. At end of shift, count the till and **blind close**: you enter the counted
total without seeing the expected amount; the printable Z-report then shows expected,
counted, and over/short. Managers can force-close an abandoned drawer from the API and
see every session under Reports → Drawer sessions.

### Admissions (`/admissions.html`)
The gate. The big input is keyboard-wedge friendly: scan or type a ticket (`T-…`) or
member pass (`M-…`) code and press Enter — a full-panel green OK or red DENIED result
shows the holder and, when denied, the machine reason (`expired`, `exhausted`,
`wrong_session_time`, `void`, `unknown`, `suspended`). Session tickets admit from 30
minutes before their session start until session end. The page shows today's admit count
and the last scans (codes appear masked — pass codes are credentials, and the feed is
visible at every gate). The gate name (top right) is remembered on this device across
reloads, and the scan box re-grabs focus after stray taps — a scanner never types into
the void. Managers/admins also get a **simulator** drawer listing currently
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
Menu builder ("generate from group"), the Store builder (group sections), Item Config, and
the group rollups in Reports and on the Dashboard.

### Events (`/events.html`)
Events and their timed sessions. **Bulk generate** creates a session grid (date range,
first/last start time, interval, capacity). The day grid shows sold/capacity with fill
colors. Capacity can be raised anytime; lowering below sold is rejected. Cancelling a
session (manager) voids its tickets.

### Menus (`/menu-builder.html`)
The POS screen designer. Create pages, then place buttons by position: **product buttons**
(custom label, color, size) or **page links** for navigation. "Generate from group" fills
a page from an item group. POS picks the design up immediately; deactivate all pages to
fall back to the automatic grid. The **Terminals** panel manages named registers
("Front Gate", "Café"…): create, rename, or deactivate a terminal and tick the pages
assigned to it. A POS register that claims a terminal shows only its assigned (and
active) pages; terminals with no assignment — and registers with no claim — show the
default menu, so an empty registry changes nothing.

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
Five date-ranged reports, each with a totals row and CSV download: **Sales summary** (by
day and channel; net = gross − discounts), **Product mix**, **Admissions** (scans, admits,
denials by reason, per gate), **Memberships** (sold/renewed, active, upcoming
expirations), **Drawer sessions** (closed drawers by day: float, cash, paid in/out,
expected vs counted, over/short — plus an "Unattributed POS cash" line that should stay
at zero). Sales summary and Admissions also offer a **Group by: item group** toggle:
totals roll up per group, products in no group land under **Ungrouped**, and products in
multiple groups count in each group — the report footer discloses that group totals can
therefore exceed the grand total. Member and unknown-code scans carry no product, so the
grouped Admissions report counts them in the footer instead of a group row. The CSV
download follows whichever mode is on screen. In every CSV export, text cells starting
with `=`, `+`, `-`, or `@` get a leading apostrophe so spreadsheets show them as text
instead of running them as formulas; money and count columns are unaffected.

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

Landing page (hero + sections from the Store Builder; the header shows your venue name),
event pages with a date picker and
live seat availability, cart (kept in the browser), and checkout: name + email, optional
discount code, simulated card — any well-formed number approves; **`4000 0000 0000 0002`
always declines** (for testing the failure path). The cart shows the exact tax and total
that will be charged, validates the three fields inline before anything is sent, and
Enter submits from any field. The confirmation page shows print-at-home
tickets with barcodes, one per page when printed. Lost the tab? `/store/order.html` re-opens
any order with its `W-…` confirmation code plus the checkout email. New memberships
bought online show the printable pass card on the confirmation page; a renewal of an
existing member is confirmed by member number and new expiry only — the pass card
stays private to its holder, since anyone knowing the email could open the order.

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
- **Production mode:** set `OWLPOS_MODE=production`, a strong `OWLPOS_SECRET`
  (at least 32 bytes, e.g. 64 hex chars) and, when seeding a fresh database,
  `OWLPOS_BOOTSTRAP_ADMIN_PASSWORD` (at least 12 chars) — the server refuses to start
  without them. A production seed never creates a usable demo credential: `admin` takes
  the bootstrap password (and must still choose their own at first sign-in), while
  `manager`/`cashier`/`gate` are created disabled. Enable the ones you need with
  `OWLPOS_USER_PASSWORD=<temp password> node tools/users.js activate <username>` (also
  `list`, `deactivate`, `set-password`) — each activated account signs in with its
  temporary password and must rotate it before anything else works. A database still
  carrying an active demo password (from a demo-mode seed or a restored demo snapshot)
  refuses to start in production until those accounts are rotated or deactivated.
  Session cookies are marked `Secure` (put the server behind HTTPS), and the login page
  stops advertising demo credentials. Behind a reverse proxy, also set
  `OWLPOS_TRUST_PROXY=1` so login rate limiting keys on real client addresses from
  `X-Forwarded-For` instead of the proxy's single address — never set it on a directly
  exposed server, where that header is attacker-controlled. In every mode, login is
  rate-limited per client address and account, five consecutive wrong passwords lock an
  account for 15 minutes (failed
  attempts land in the audit log), voids/refunds require a manager to enter their own
  credentials, and the Password button in the top bar changes your password — which also
  signs out every other session for the account. **Sign out** does the same: it revokes
  every session for your account (not just this browser's cookie) — the right behavior
  on shared POS stations.

## Backup and restore runbook

- **Where snapshots live:** `data/backups/owlpark-<timestamp>-<scheduled|manual>.db`
  (directory overridable via env `OWLPOS_BACKUP_DIR`), file mode 0600. Each snapshot is the complete database (including staff password hashes
  and member emails) — copy the folder offsite regularly (`rsync data/backups/ …`) and
  treat the copies as sensitive.
- **Taking one:** the Backups page (**Back up now**) or wait for the scheduler. Tune with
  `settings` keys `backups.interval_min` (0 disables the scheduler) and `backups.retain`,
  or env `OWLPOS_BACKUP_INTERVAL_MIN` / `OWLPOS_BACKUP_RETAIN`. The scheduler reads
  `interval_min` at startup, so restart the server after changing it; `retain` takes
  effect on the next backup.
- **Restoring:** stop the server, then:

  ```
  node tools/restore.js data/backups/<snapshot>.db
  ```

  The tool verifies the snapshot's integrity, refuses snapshots created by newer code
  than this checkout, keeps your current database beside the restored one as
  `owlpark-pos-pre-restore-<timestamp>.db`, and records the restore in the audit log.
  Older snapshots are fine — pending migrations apply on the next start. While the
  database's `-wal`/`-shm` sidecar files exist the tool refuses to run — they mean the
  server is still running (stop it first) or crashed without a clean shutdown; only in
  the crash case pass `--force` to proceed anyway. Any failure mid-restore rolls back
  and leaves your original database in place. Use `--db <path>` for a non-default
  database location.
- **Health:** `/api/health` shows disk-free, database size, and last-backup time to
  signed-in admins/managers; the shell shows a persistent banner when disk is low.
