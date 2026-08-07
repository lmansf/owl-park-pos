# platform-core (delta)

## MODIFIED Requirements

### Requirement: Back-office app shell

A shared shell (`web/shell.css`, `web/shell.js`) SHALL provide: top navigation to Dashboard,
POS, Admissions, Catalog, Events, Members, Reports; the signed-in user + logout; a `op.api()`
fetch helper that surfaces API errors as toasts; and role-aware nav (e.g. `gate` sees only
Admissions). Unauthenticated visits to any back-office page redirect to `/login.html`.

Toasts SHALL be click-to-dismiss, error toasts SHALL stay visible longer (8s vs 5s), and
an identical still-visible message SHALL be collapsed (its timer restarted) instead of
stacked; toast content stays `textContent` — never HTML. The unauthenticated (and
password-change) redirects SHALL preserve the page's full relative path **and query
string** in `?next=` (same-origin relative only, encoded). The shell SHALL export a
`busy(btn, fn)` helper that disables a button while an async action runs — the shared
disable-while-pending / double-submit guard — and the stylesheet SHALL provide a global
`:focus-visible` ring on actionable elements plus an `.op-skel` skeleton class for
loading placeholders. Pages that fetch data on load SHALL show a loading state (skeleton
tiles or a Loading row) rather than blank panes, and list panes SHALL have explicit
empty states.

#### Scenario: Gate operator lands on Admissions
- **WHEN** user `gate` logs in
- **THEN** they are taken to Admissions and the nav shows only pages their role can use.

#### Scenario: Session expiry returns to the exact view
- **WHEN** a signed-out user hits a page at `/item-config.html?id=7`
- **THEN** after signing in they land back on `/item-config.html?id=7`, query intact.

#### Scenario: Failed login recovers in place
- **WHEN** a sign-in attempt fails
- **THEN** an inline generic error appears (no username oracle), the password field is
  cleared and refocused, and the lockout hint appears after repeated failures.
