# membership (delta)

## ADDED Requirements

### Requirement: Structured member order lines

Order lines for membership products SHALL carry structured member data: `member_id` for
renewals of an existing member, or a `member_intent` JSON payload (name, email) for a
new membership to be created at finalize. `finalizeOrder` SHALL consume these columns;
no code path SHALL parse member information out of the human-readable line description,
which becomes display-only.

#### Scenario: Renewal without text parsing
- **WHEN** a renewal line is finalized for member #42
- **THEN** the member's expiry extends based on `order_lines.member_id = 42`, regardless
  of what the line description says.

#### Scenario: Web store new member
- **WHEN** a store checkout includes a membership for "Ada <ada@example.com>"
- **THEN** the new member is created from the line's `member_intent` payload and the
  description is never parsed.

### Requirement: Legacy line backfill

The migration SHALL best-effort backfill structured columns from the legacy
"(renewal #N)" / "(for Name <email>)" description formats on existing orders regardless
of status — open orders included, so a pre-migration open renewal finalized after deploy
still targets the right member — and SHALL leave unparseable rows untouched (columns
NULL) rather than guessing.

#### Scenario: Historical renewal is queryable
- **WHEN** the migration runs on a DB containing a pre-change renewal line "(renewal #7)"
- **THEN** that row gains `member_id = 7` and reporting can join it to the member.
