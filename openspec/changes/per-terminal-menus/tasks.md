# Tasks — per-terminal-menus

## Phase A — core (serial)

- [ ] A1 Migration: `terminals` + terminal-menu assignment table

## Phase B — one team (builder → verifier)

- [ ] B1 menus.js: terminal CRUD + assignment routes; `getActiveMenu(db, terminal?)`
      additive; zero-arg contract unchanged (regression test)
- [ ] B2 menu-builder.html: terminals panel + assignment UI
- [ ] B3 pos.html: claim/switch terminal (manager), request menu by terminal, fallback
      chain intact
- [ ] B4 Tests: assignment resolution, unassigned fall-through, deactivated terminal;
      smoke claims a terminal and sells from its menu

## Phase C — integration (serial)

- [ ] C1 Full suite + smoke green; archive
