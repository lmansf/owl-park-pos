# Demo → production: what a small/medium business deployment would require

Requested by the captain during the 2026-08-06 OpenSpec review. This outlines the gap
between the current demo and a system an SMB attraction could actually run. Items marked
(proposed) already have an OpenSpec change under `openspec/changes/`; items marked
(shipped) are implemented and archived under `openspec/changes/archive/`.

## 1. Security and auth — the biggest gap

Demo mode stays demo-grade by design: seeded well-known passwords, a per-process
fallback secret, everything trusts localhost. The shipped `security-hardening` change
added an `OWLPOS_MODE=production` mode plus lockout, rate limiting, and session
revocation in every mode; still no 2FA.

- Forced password setup on first run; password policy + rotation; account lockout and
  login rate-limiting; audit-visible failed logins. (shipped: `security-hardening` —
  all but a rotation schedule)
- Mandatory `OWLPOS_SECRET` provisioning (fail closed if unset outside demo mode);
  secret rotation story. (shipped: `security-hardening` — fail-closed; rotation open)
- TLS everywhere (reverse proxy or built-in via `node:tls`), HSTS, secure cookies.
  (`security-hardening` covers Secure/Strict cookies; TLS itself stays a proxy concern)
- Role hardening: per-station gate accounts, manager-override credentials for
  voids/refunds (attributed in audit — shipped: `security-hardening`), session
  revocation (shipped: `security-hardening` via signed per-user token epochs, chosen
  over a denylist because serverless demo instances have per-instance DBs).
- Backup authentication for the back office if exposed beyond the LAN (VPN or IP
  allowlist; the store is the only surface that should ever be public).

## 2. Real payments

Simulated card tender today. An SMB needs:

- Semi-integrated card terminals (Stripe Terminal, Adyen, SumUp, or a local acquirer):
  the POS never touches card data, keeping PCI scope at SAQ-level minimal. This slots
  into the tender registry (proposed: `pluggable-tenders`) as an `authorize` hook that
  talks to the terminal — which means relaxing the zero-network constraint for exactly
  this integration, behind a config flag.
- Tender reconciliation: settlement/batch reports matched against the daily journal
  (`chart-of-accounts` already balances per day — extend with processor settlement
  import).
- Refund-to-original-tender flows (builds on proposed `partial-refunds-exchanges`).

## 3. Data durability and operations

One SQLite file today; hosted demo is intentionally ephemeral.

- Scheduled backups (SQLite online backup API), tested restore, offsite copy;
  WAL checkpointing policy.
- Either commit to single-host SQLite (fine for one venue; document the operational
  envelope) or plan a Postgres migration path for multi-venue.
- Crash-safe printing/ticket issuance: idempotent finalize retries (order posting is
  already transactional — extend with client idempotency keys).
- Monitoring: health endpoint exists (`/api/health`); add structured logs, error
  alerting, disk-space watchdog.
- Upgrade story: versioned releases, migration dry-run against a backup, rollback plan.

## 4. Hardware

Explicitly out of scope in the demo; an SMB needs:

- Receipt/ticket printers (ESC/POS over USB/network) and boarding-style ticket stock;
  print spooling with reprint on jam.
- Barcode/QR scanners (keyboard-wedge already works; add camera scanning for gates).
- Cash drawers (kick via printer), customer-facing display optional.
- Gate hardware: handheld scanners or fixed lanes hitting `admissions.checkCode` —
  the single-admit-path invariant is exactly right for this; keep it.

## 5. Multi-terminal and venue realities

- Multiple POS stations on a LAN against one server (works today in principle;
  needs per-terminal identity — proposed: `per-terminal-menus` — plus per-station
  cash-drawer sessions: open float, paid-in/out, blind close, over/short reporting).
- Shift management and Z-reports per drawer/day.
- Offline tolerance at the gate: cached ticket-validity window for network blips
  (bounded, reconciled on reconnect) — a real design problem, spec it before building.
- Time-zone correctness: day boundaries are server-local everywhere; pin the venue
  time zone explicitly in settings.

## 6. Commerce and compliance

- Tax: jurisdiction-correct rates and rounding rules, tax-exempt sales, receipts that
  meet local requirements (business ID, tax breakdown); fiscal-printer/registrar
  requirements in some countries can be a hard blocker to research early.
- Refund policy enforcement + manager overrides (builds on `partial-refunds-exchanges`).
- Accounting export: map the daily journal (already balanced) to CSV formats the
  business's accountant/software actually ingests (QuickBooks/Xero-style journals).
- Web store production needs: real email delivery for confirmations (order recovery
  exists), CAPTCHA/abuse throttling on checkout, GDPR-style data retention for
  customer/member PII, cookie/privacy pages.
- Memberships: payment-on-file renewals are a large scope step — defer or make
  renewal reminders email-only at first (builds on `member-order-lines`).

## 7. What to keep exactly as-is

- The two invariant chokepoints (`pos.finalizeOrder`, `admissions.checkCode`) — they are
  the reason this system can grow safely.
- Core-owned DDL and frozen cross-module contracts.
- Integer-cents money, ISO-UTC timestamps.
- The zero-dependency discipline for everything except the explicit payment-terminal
  and email integrations, which should be isolated behind small adapters.

## Suggested sequencing for an SMB pilot

1. Security hardening (§1) + backups/ops (§3) — prerequisite for anything real.
2. `pluggable-tenders` → semi-integrated card terminal (§2).
3. Hardware: printer + scanner + drawer (§4).
4. Drawer sessions/Z-reports + `per-terminal-menus` (§5).
5. Tax/receipt compliance for the venue's jurisdiction (§6).
6. Web store production checklist (§6) last — the on-site loop earns money first.
