# events-capacity Specification

## Purpose
TBD - created by archiving change pos-mvp. Update Purpose after archive.
## Requirements
### Requirement: Events with timed sessions

Managers SHALL manage events (e.g. "Planetarium Show") and their sessions: start/end time
and capacity. Bulk session generation SHALL exist (date range + times/interval + capacity).
UI: `web/events.html` with a per-day session grid showing sold/capacity.

#### Scenario: Bulk generate
- **WHEN** a manager generates sessions daily 10:00–17:30 every 90 min for 14 days, capacity 40
- **THEN** the grid shows those sessions, each 0/40 sold.

### Requirement: Availability API

`GET /api/events/:id/sessions?from=&to=` SHALL return sessions with `remaining =
capacity - sold`, and a session with `remaining <= 0` is marked sold out. The online store
and POS session pickers SHALL both consume this endpoint.

#### Scenario: Sold-out hidden from sale
- **WHEN** a session's sold count reaches capacity
- **THEN** the store shows it as sold out and attempts to add it to a cart are rejected.

### Requirement: Transactional capacity guard

Session inventory SHALL only change inside order posting: a single SQLite transaction that
re-checks `sold + qty <= capacity` per session before incrementing `sold` and issuing
tickets, failing the whole order with a `capacity` error otherwise. Voids/refunds decrement
`sold` in the same transaction that voids the tickets.

#### Scenario: Race at the last seat
- **WHEN** two orders for the last remaining seat post back-to-back
- **THEN** exactly one succeeds; the other fails with a capacity error and no partial state
  (no tickets, no payment, no sold increment).

### Requirement: Capacity edits respect sales

Reducing a session's capacity below its sold count SHALL be rejected; cancelling a session
with sold tickets requires manager role and voids its tickets with an audit entry.

#### Scenario: Shrink below sold
- **WHEN** a session has sold 12 and a manager sets capacity to 10
- **THEN** the edit is rejected with an explanatory error.

