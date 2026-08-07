# Tasks — reporting-by-group

## Phase B — one team (builder → verifier; no core phase, no DDL)

- [x] B1 reporting.js: group mode for sales + admissions via groups.js exports;
      Ungrouped bucket; CSV (implemented in `server/modules/reports.js` — the module's
      actual filename; "reporting" is the spec name)
- [x] B2 reports.html: group-by toggle; index.html today-by-group tile
- [x] B3 Tests: rollup math, multi-group double-count + disclosure, ungrouped bucket;
      smoke asserts a grouped report over its mixed day

## Phase C — integration (serial)

- [x] C1 Full suite + smoke green; archive
