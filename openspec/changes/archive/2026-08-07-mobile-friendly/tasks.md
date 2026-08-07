# Tasks — mobile-friendly

## Phase B — one team (builder → verifier; CSS only, no core phase)

- [x] B1 shell.css: ≤640px breakpoint (scrollable op-tables, 16px inputs, toast span,
      tighter spacing, safe-area topbar, brand tagline hidden), text-size-adjust
- [x] B2 store.css: same treatment for the guest store (grid, cart table, hero, totals)
- [x] B3 pos.html: stack sell layout ≤900px via minmax(0,1fr); form-grid pages
      (item-config, discounts, price-programs, store-builder + hero-grid, menu-builder)
      collapse ≤560px; item-groups picker stacks; mb-layout fallback minmax(0,1fr)
- [x] B4 Verified at 390px viewport (store index/cart/event, POS, reports, dashboard,
      catalog, events, members, item-groups, admissions, menu-builder, item-config,
      discounts, price-programs, store-builder, accounts, help): scrollWidth 390
      everywhere; desktop 1280px layout unchanged (pos-sell 852px/380px);
      `node --test` green
