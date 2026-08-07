# Change: per-terminal-menus — assign designed menus to named terminals

## Why

The menu builder ships one active menu for every POS. Real venues run different layouts
at different stations (front gate sells tickets, café sells food). Per-terminal
assignment was an explicit non-goal of back-office-builders; this change promotes it.

## What Changes

- Named terminals: a small registry (id, name, active) managed inside the menu builder
  UI; a POS browser claims a terminal identity once (stored locally, switchable by
  manager).
- Menu assignment: each terminal may be assigned a menu page-set; unassigned terminals
  (and POS sessions with no claimed terminal) keep today's behavior — the single active
  menu, then the auto-grid fallback.
- `getActiveMenu(db)` gains an optional terminal argument; the zero-argument call keeps
  its exact current contract (frozen for existing consumers).

## Non-goals

No per-terminal pricing, tax, or user restrictions; no hardware identity (a terminal is
a name a browser claims, consistent with the no-hardware constraint); no per-terminal
reporting in this change.

## Impact

Migration for `terminals` + assignment table (core-owned DDL), `server/modules/menus.js`
(additive export change), `web/menu-builder.html` (terminal panel),
`web/pos.html` (claim/switch terminal, request menu by terminal).
