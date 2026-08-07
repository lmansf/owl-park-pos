# Tasks — per-terminal-menus

## Phase A — core (serial)

- [x] A1 Migration: `terminals` + terminal-menu assignment table

## Phase B — one team (builder → verifier)

- [x] B1 menus.js: terminal CRUD + assignment routes; `getActiveMenu(db, terminal?)`
      additive; zero-arg contract unchanged (regression test)
- [x] B2 menu-builder.html: terminals panel + assignment UI
- [x] B3 pos.html: claim/switch terminal (manager), request menu by terminal, fallback
      chain intact
- [x] B4 Tests: assignment resolution, unassigned fall-through, deactivated terminal;
      smoke claims a terminal and sells from its menu

## Phase C — integration (serial)

- [ ] C1 Full suite + smoke green; archive
