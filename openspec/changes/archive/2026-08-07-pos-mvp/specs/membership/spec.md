# membership (delta)

## ADDED Requirements

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
the confirmation page shows the pass card for print-at-home.

#### Scenario: Web-sold membership
- **WHEN** a guest buys a membership online
- **THEN** the confirmation shows their member number, expiry, and barcode pass, and the
  member exists in back-office search.
