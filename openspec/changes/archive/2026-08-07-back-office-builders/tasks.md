# Tasks — back-office-builders

## Phase A — core groundwork (coordinator, serial)

- [x] A1 Migration `003_builders.sql` (all nine tables per design)
- [x] A2 Shell nav entries: Groups, Menus, Store Builder, Discounts, Accounts, Pricing

## Phase B — parallel editor teams (builder → verifier each)

- [x] B1 Team item-config: item-config.html, discounts.html, slim catalog.html, catalog.js additive extensions
- [x] B2 Team item-groups: groups.js, item-groups.html, read API + exports
- [x] B3 Team menu-builder: menus.js, menu-builder.html, pos.html menu rendering + fallback
- [x] B4 Team webstore-builder: storefront.js, store-builder.html, store/index.html layout rendering + fallback
- [x] B5 Team chart-of-accounts: accounts.js (default chart self-init), accounts.html, balanced journal + CSV
- [x] B6 Team price-programs: pricing.js (resolvePrice), price-programs.html

## Phase C — integration (coordinator, serial)

- [x] C1 Wire pricing into catalog.getSellable + pos.createOrder (presence-guarded)
- [x] C2 Extend tools/smoke.js: designed menu at POS, store layout render, program price
      honored in POS + store orders, journal balances over the smoke's mixed day
- [x] C3 Full suite + smoke green; AGENTS.md touch-up; commit; push to GitHub
