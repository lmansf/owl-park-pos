# Overnight production push — 2026-08-06 → 08-07

What ran while you were away, what changed, and what is left for you. Standing
instruction for the run: research → build → test → security-test → review → repeat,
merging each feature individually, swarming for parallelism, fully autonomous.

## Outcome in one line

Fifteen PRs merged: ten features, three rounds of audit fixes, and two follow-ups.
The suite went from 259 to 431 tests, all green, with the end-to-end smoke at 97 checks.
The POS is materially closer to something a small venue could run — but three things
only you can do still stand between it and a real till (see "Your steps").

## Shipped features (each: OpenSpec change → build → tests → gate → merge → archive)

| # | Feature | What it gives the venue |
| --- | --- | --- |
| 1 | OpenSpec expansion | Main specs exist; 14 capabilities documented as the contract authority |
| 2 | mobile-friendly | Every surface renders at iPhone width; verified page-by-page in a real browser |
| 4 | security-hardening | Production mode, forced password rotation, lockout + rate limiting, session revocation, manager approval for voids/refunds |
| 5 | backups-ops | Scheduled + on-demand SQLite snapshots, restore tool, structured logs, disk/backup health |
| 6 | reporting-by-group | Sales and admissions rolled up by item group, with CSV |
| 7 | member-order-lines | Membership data in real columns (was text-encoded in descriptions) — killed the repo's documented sharpest edge |
| 8 | pluggable-tenders | Tender registry behind the posting path; adding a payment method no longer touches `finalizeOrder` |
| 9 | partial-refunds-exchanges | Per-line refunds with exact cent allocation; capacity-safe session exchanges |
| 10 | per-terminal-menus | Named terminals with their own menu page-sets; unassigned terminals behave exactly as before |
| 11 | drawer-sessions-zreports | Cash drawer sessions: float, paid in/out, blind close, over/short, Z-reports, drawers reconciliation |
| 12 | ux-friction-pass | Keyboard-first POS, one-form checkout, loading/empty states, inline validation everywhere |

## Audit and hardening

Two adversarial audit rounds ran over the merged code. Every finding was raised by one
agent and then attacked by an independent verifier told to refute it; only survivors were
fixed, and every fix carries a regression test proven to fail without it.

- **Round 1**: 27 raised → 21 confirmed → all fixed (PR 13).
- **Round 2** (over the fixed code): 23 raised → 17 confirmed → all fixed.
- **Follow-ups**: strict integer parsing unified into one shared helper; docs repointed at
  live specs (PR 15).

### The findings that mattered most

- **Server killed by one anonymous request.** `GET /%zz` threw a `URIError` outside any
  try/catch; the discarded dispatch promise became an uncaught exception and the process
  exited. Any visitor could take the park offline. Fixed and verified live.
- **Two memberships sold to one email became one.** Each unit renewed the member the
  previous unit had just created, so the venue took two payments and delivered one card
  with double duration. Named members now always get their own membership.
- **Production mode shipped usable default credentials**, and the forced-password-change
  fence did not stop a default-credential admin takeover.
- **Free tickets.** A cleared price field in the price-program editor stored a `null`,
  which became a 0-cent override that flowed into the sellable feed — an Adult ticket
  would have sold for $0.00 at the desk and online.
- **The documented restore runbook could never complete.** The app had no clean shutdown,
  so the WAL files always remained and the guard demanded `--force` every single time,
  training operators to bypass the only protection. Fixed on both sides.
- **Receipts lied.** Blind-drawer withholding printed real tenders as "withheld $0.00" on
  reprints and refunds. Refund receipts now always state what came back.
- Plus: CSV formula injection in every export, guest store disclosing another member's
  pass code, unescaped manager-written HTML on the storefront, gate role reading the
  financial dashboard, world-readable database files, and an abandoned drawer being
  invisible to every report.

## Your steps (the things an agent should not decide alone)

1. **Provision `OWLPOS_SECRET`** and run with `OWLPOS_MODE=production`. Generate 32+ bytes
   (`openssl rand -hex 32`). The server refuses to start in production without it.
2. **Create the first real admin** with `tools/users.js`, then remove or rotate the demo
   accounts. Production mode no longer accepts the seeded defaults as-is.
3. **Terminate TLS** in front of the app (reverse proxy or tunnel) and set
   `OWLPOS_TRUST_PROXY=1` so rate limiting and audit logs see real client IPs.
4. **Decide the card story.** The tender registry has the seam ready; a semi-integrated
   terminal (Stripe Terminal, SumUp, a local acquirer) keeps card data out of the app and
   PCI scope minimal. This is a commercial decision plus the one place the zero-network
   rule would be relaxed.
5. **Check tax and receipt rules for your jurisdiction** before taking real money. Some
   places require fiscal registration — worth researching early since it can be a blocker.
6. **Set up offsite backup copies.** Snapshots land in `data/backups/` and contain staff
   password hashes and member emails; treat them as sensitive.

## Known follow-ups (logged, not blocking)

- `membership.js` should expose an explicit "always create" option; `pos.js` currently
  reaches that branch indirectly.
- Membership reversal on refund writes member rows from `pos.js`; its proper home is a
  `membership.revokeForRefund` export.
- A membership line with qty > 1 mints N members but `order_lines.member_id` stamps only
  one — a link table would let the guest view and refund reversal see all of them.
- Spec deltas for the new abandon route and membership-reversal-on-refund.

## Notes on how it ran

- Firstmate could not be reached: the relay is sandboxed away from `/mnt/storage/fm-home`,
  so it never saw the project. To use it on future overnight runs, launch it with
  `FM_HOME=/mnt/storage/fm-home` from a session with real filesystem access.
- Vercel's commit status wedged on every PR (preview deployed, status never flipped).
  Merges proceeded after a consistent wedge window, per the precedent set on PR 1.
- Worktree agents share one `git stash` stack; two collided mid-run. Recovered with no
  loss, but future swarms should revert by file copy, never `git stash`.
- Supabase was not needed. Everything stayed on local SQLite, as you preferred.
