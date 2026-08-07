# membership Specification

## Purpose
Memberships: programs, member records with scannable member codes, and purchase/renewal
through the normal order flow, so members are sold and admitted with the same chokepoints
as tickets.
## Requirements
### Requirement: Membership programs

Admins/managers SHALL manage membership programs (name, duration days, price, benefits
text). Each program is sellable via a linked catalog product of kind `membership`.

#### Scenario: Program price flows from catalog
- **WHEN** a manager edits the linked product's price
- **THEN** POS and store sell the membership at the new price; the program itself stores no
  duplicate price.

### Requirement: Member lifecycle

Selling a membership product SHALL create (or renew) a member during order posting: member
number `GM-XXXXXX`, pass code `M-…`, `expires_at = max(now, current expiry) + duration`.
Buyer name/email are captured at sale. Members can be searched, viewed, edited, suspended,
and reinstated in `web/members.html`.

#### Scenario: Renewal extends, not resets
- **WHEN** a member with 30 days remaining buys the same program (365 days)
- **THEN** their new expiry is 395 days out and the same member record/pass code is kept.

### Requirement: Member pass output

The member detail view SHALL render a printable pass card: venue name, member name, number,
program, expiry, and the pass code as Code 39 barcode — the code the gate scans.

#### Scenario: Pass scans at gate
- **WHEN** a freshly sold member's pass code is scanned
- **THEN** admission is OK and shows the member's name and program.

### Requirement: POS/store attach

At POS, selling a membership SHALL prompt for member name + email (new) or a member search
(renewal). In the online store, membership purchases capture the same fields at checkout and
the confirmation page shows the pass card for print-at-home — but only for a member this
very order created. The order email is unverified guest input, so a renewal of a
pre-existing member SHALL be acknowledged by member number and new expiry only — never
the stored name or pass code, which would hand the member's gate credential to anyone
who knows their email address.

#### Scenario: Web-sold membership
- **WHEN** a guest buys a membership online
- **THEN** the confirmation shows their member number, expiry, and barcode pass, and the
  member exists in back-office search.

#### Scenario: Web renewal does not disclose the pass
- **WHEN** a guest order renews an existing member and the guest view is fetched
- **THEN** the response carries the member number and new expiry but no pass code and
  not the member's stored name.

### Requirement: Structured member order lines

Order lines for membership products SHALL carry structured member data: `member_id` for
renewals of an existing member, or a `member_intent` JSON payload (name, email) for a
new membership to be created at finalize. `finalizeOrder` SHALL consume these columns;
no code path SHALL parse member information out of the human-readable line description,
which becomes display-only.

One membership sold SHALL be one membership delivered: a line carrying `member_intent`
(the POS new-member prompt, the gift path) ALWAYS mints its own member — even when an
active member already carries that email — and only an explicit `member_id` renews. A
bare line (no member info, buyer's own email) keeps the legacy renew-by-email match,
but at most once per (program, email) per order, so further units mint fresh members
instead of silently stacking duration onto the member the first unit just posted.

#### Scenario: Two memberships to one email are two members
- **WHEN** an order finalizes with two new-member membership units naming the same
  household email
- **THEN** two distinct members are minted, each with a single program duration — never
  one member with doubled duration.

#### Scenario: Renewal without text parsing
- **WHEN** a renewal line is finalized for member #42
- **THEN** the member's expiry extends based on `order_lines.member_id = 42`, regardless
  of what the line description says.

#### Scenario: Web store new member
- **WHEN** a store checkout includes a membership for "Ada <ada@example.com>"
- **THEN** the new member is created from the line's `member_intent` payload and the
  description is never parsed.

### Requirement: Per-unit posted member records

`order_lines.member_id` can hold only one member while a qty>1 membership line posts
one member per unit, so `finalizeOrder` SHALL record every member a line actually
posted in `order_line_members` — one row per unit, marked `minted` (a member this
order created) or `renewed` (an existing member extended). Refunding q units of a
membership line SHALL reverse exactly q posted memberships from that set, most
recently posted first: a minted member is suspended, a renewed member gives back one
program duration. Order views (back office and guest) SHALL list every member posted
on the line. `member_id` SHALL stay stamped with the last posted member for
compatibility with anything still joining through it, and the migration SHALL
backfill link rows for already-posted lines from that stamp so historical refunds
keep working.

#### Scenario: Qty-2 line refunds deterministically
- **WHEN** a qty-2 membership line minted members A then B and one unit is refunded
- **THEN** B (the most recently minted) is suspended while A keeps its full term, and
  refunding the remaining unit suspends A too.

#### Scenario: Qty-2 purchase delivers two pass cards
- **WHEN** a guest buys a qty-2 membership line online
- **THEN** the confirmation shows both minted members' pass cards, not just the last
  one stamped on the line.

### Requirement: Legacy line backfill

The migration SHALL best-effort backfill structured columns from the legacy
"(renewal #N)" / "(for Name <email>)" description formats on existing orders regardless
of status — open orders included, so a pre-migration open renewal finalized after deploy
still targets the right member — and SHALL leave unparseable rows untouched (columns
NULL) rather than guessing.

#### Scenario: Historical renewal is queryable
- **WHEN** the migration runs on a DB containing a pre-change renewal line "(renewal #7)"
- **THEN** that row gains `member_id = 7` and reporting can join it to the member.

### Requirement: Confirmed program deletion

Deleting a membership program from the Members page SHALL require an explicit
confirmation naming the program and stating that deletion is irreversible and refused
for programs with members. The server-side `program_in_use` guard remains the
enforcement of record; the confirmation is UX only. Reversible actions (suspend,
deactivate toggles) stay confirmation-free with explanatory toasts.

#### Scenario: Delete asks first
- **WHEN** a manager clicks Delete on program "Explorer Annual"
- **THEN** a confirmation naming "Explorer Annual" appears; cancelling leaves the
  program untouched, and confirming still 409s if the program has members.

