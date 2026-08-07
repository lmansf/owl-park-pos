# drawer-sessions (delta)

## ADDED Requirements

### Requirement: Drawer lifecycle

The system SHALL provide per-cashier cash-drawer sessions: `POST /api/drawer/open`
(cashier/manager/admin) opens a session with a counted opening float (integer cents,
0 ≤ v ≤ 10,000,000) and an optional display-only `terminal` label (≤ 40 chars, default
`main`). At most one session per user may be `open` at a time — checked inside a
transaction and backstopped by a partial unique index. `GET /api/drawer/current`
returns the caller's own open session only; `current`, `movements`, and blind `close`
never accept a session id from the client. All lifecycle mutations write `audit_log`
rows (`drawer.open`, `drawer.movement`, `drawer.close`).

#### Scenario: Second open is refused
- **WHEN** a cashier with an open drawer session calls `POST /api/drawer/open`
- **THEN** the response is 409 `drawer_already_open` and no new session row exists.

#### Scenario: Gate role has no drawer
- **WHEN** a `gate` user calls any `/api/drawer/*` route
- **THEN** the response is 403.

### Requirement: Cash attribution through the shared posting path

POS-channel payments SHALL be stamped with the order's cashier's open drawer session
(`payments.drawer_session_id`) inside `pos.finalizeOrder`'s transaction — the session
is re-resolved in-tx so a concurrently closed session is never stamped. A cash-bearing
POS finalize with no open drawer for the cashier SHALL fail 409 `no_open_drawer` with
full rollback; card-only POS finalizes succeed (attributed when a drawer is open, NULL
otherwise); web-channel orders never require a drawer and their payments stay NULL.
Refunds never require a drawer; negative payment rows are stamped with the acting
user's open session when one exists, else NULL. The drawer module SHALL never write
`payments` rows — attribution happens only inside the pos module's posting path.

#### Scenario: Cash sale without a drawer rolls back
- **WHEN** a cashier with no open drawer finalizes a POS order with a cash tender
- **THEN** the response is 409 `no_open_drawer`, the order stays `open`, no tickets
  exist, and session `sold` counts are unchanged.

#### Scenario: Web checkout is unaffected
- **WHEN** a web-channel order is finalized while no drawer session exists anywhere
- **THEN** it succeeds and its payment rows carry `drawer_session_id` NULL.

### Requirement: Paid-in and paid-out movements

`POST /api/drawer/movements` (own open session only) SHALL record reasoned movements:
`kind` ∈ {`paid_in`, `paid_out`}, integer `amount_cents` 1–10,000,000, required
`reason` (1–200 chars, stored verbatim as data and escaped at render time). The ledger
is immutable — there are no update or delete routes — and each movement is audited.
Paid-outs SHALL NOT be validated against the drawer balance (only the static cap), so
error responses cannot be used to binary-search the expected total before a blind
count.

#### Scenario: Movement without a drawer
- **WHEN** a cashier with no open session posts a movement
- **THEN** the response is 409 `drawer_not_open` and nothing is written.

#### Scenario: Oversized paid-out is not a balance oracle
- **WHEN** a cashier paid-outs an amount far beyond the drawer's contents
- **THEN** the movement is accepted; only amounts above the static cap are rejected.

### Requirement: Blind close and over/short

`POST /api/drawer/close` SHALL close the caller's own open session from a counted cash
total entered blind: `expected_cents = open_float_cents + Σpaid_in − Σpaid_out +
Σ(amount_cents − change_cents)` over cash payments attributed to the session (negative
refund rows net out automatically), `over_short_cents = counted_cents −
expected_cents`, both computed once inside the close transaction and persisted with a
sequential `z_number` (`1 + MAX(z_number)`, UNIQUE). Before close, no API response
readable by the session's opener reveals expected cash or any derived cash sum for
that open session — `GET /api/drawer/current` returns the float, the movement list,
and a payment COUNT only. Closed sessions are immutable: no movements, no re-close
(409 `drawer_not_open`). Managers MAY force-close any open session via
`POST /api/drawer/sessions/:id/close` (manager/admin); the audit row is marked
`forced`.

#### Scenario: Counted differs from expected
- **WHEN** a cashier closes a drawer whose expected cash is $237.82 with a counted
  total of $237.32
- **THEN** the close response and the audit row carry over/short −50 cents, and the
  session's Z-report shows expected, counted, and over/short.

#### Scenario: Pre-close responses stay blind
- **WHEN** the opener calls `GET /api/drawer/current` or the open session's Z route
- **THEN** no field of any 2xx response contains expected or summed cash (the Z route
  answers 409 `drawer_not_closed` while the session is open).

### Requirement: Z-report per session

`GET /api/drawer/sessions/:id/z` SHALL return a closed session's Z-report as uniform
report sections (JSON, or CSV via `?format=csv`): a cash reconciliation waterfall
(float, cash sales net of change, cash refunds, paid in/out, expected, counted,
over/short), a payments-by-method section equal to the `payments` rows attributed to
that session (the reconciliation contract), and the movement ledger. Access: managers
and admins, or the session's `opened_by` user; anyone else receives the same 404 as a
nonexistent id. `GET /api/drawer/sessions` (manager/admin) lists sessions date-ranged
with the standard local-day range semantics; expected/over-short appear only as the
persisted values of closed sessions (null while open).

#### Scenario: Cashier probes another user's Z
- **WHEN** cashier A requests the Z of a session opened by user B
- **THEN** the response is 404, indistinguishable from a nonexistent session id.

#### Scenario: Z equals payments
- **WHEN** a session's Z-report is fetched after mixed cash/card activity
- **THEN** its payments-by-method totals equal `SUM(amount_cents − change_cents)`
  grouped by method over `payments WHERE drawer_session_id = :id`.
