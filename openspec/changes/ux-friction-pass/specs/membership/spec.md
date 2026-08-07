# membership (delta)

## ADDED Requirements

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
