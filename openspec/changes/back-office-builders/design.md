# Design — back-office-builders

Everything from `openspec/changes/pos-mvp/design.md` still holds (stack, router, module
shape, money/time conventions, file-ownership discipline). This wave adds six teams.

## New tables (ALL in core migration `server/migrations/003_builders.sql`; teams write NO DDL)

- `item_groups(id, name, sort DEFAULT 0, color DEFAULT '', active DEFAULT 1)`
- `product_groups(product_id, group_id, PRIMARY KEY(product_id, group_id))`
- `menu_pages(id, name, sort DEFAULT 0, active DEFAULT 1)`
- `menu_buttons(id, page_id, position, label DEFAULT '', color DEFAULT '',
  size CHECK(size IN('sm','md','lg')) DEFAULT 'md', product_id NULL, link_page_id NULL,
  active DEFAULT 1)` — a button is a product button XOR a page link.
- `store_sections(id, title, kind CHECK(kind IN('hero','products','groups','html')), sort,
  active DEFAULT 1, config DEFAULT '{}')` — config is JSON: `{product_ids:[…]}` for
  products, `{group_id}` for groups, `{html}` for html sections.
- `accounts(id, code UNIQUE, name, kind CHECK(kind IN('asset','liability','income',
  'expense','clearing')), active DEFAULT 1)`
- `account_map(id, scope CHECK(scope IN('product','tax_group','tender','discount')),
  ref_key, account_id, UNIQUE(scope, ref_key))` — ref_key is the product/tax-group/discount
  id as text, or the tender method name (`cash`, `card_sim`).
- `price_programs(id, name, starts_on, ends_on, priority DEFAULT 0, active DEFAULT 1)` —
  dates are local `YYYY-MM-DD`, inclusive.
- `price_program_entries(program_id, product_id, price_cents,
  PRIMARY KEY(program_id, product_id))`

## Team ownership (files this wave; touch nothing else)

| Team | server | web | tests |
| --- | --- | --- | --- |
| item-config | `modules/catalog.js` (extend, keep existing exports/routes intact) | `item-config.html`, `discounts.html`, `catalog.html` (slim to products + links) | `tests/item-config.test.js` |
| item-groups | `modules/groups.js` | `item-groups.html` | `tests/groups.test.js` |
| menu-builder | `modules/menus.js` | `menu-builder.html`, `pos.html` (menu rendering + fallback) | `tests/menus.test.js` |
| webstore-builder | `modules/storefront.js` | `store-builder.html`, `store/index.html` (+`store/store.js` if needed) | `tests/storefront.test.js` |
| chart-of-accounts | `modules/accounts.js` | `accounts.html` | `tests/accounts.test.js` |
| price-programs | `modules/pricing.js` | `price-programs.html` | `tests/pricing.test.js` |

Shell nav already contains entries for every new page (core added them before this wave).

## Cross-team contracts (frozen)

- `groups.js` exports `listGroups(db)` → `[{id,name,sort,color,active,product_count}]`,
  `productIdsInGroup(db, groupId)` → `[id…]`, `groupsForProduct(db, productId)`.
  Routes: `GET /api/groups` (roles `[]`), CRUD + `PUT /api/groups/:id/products {product_ids}`
  (admin/manager).
- `pricing.js` exports `resolvePrice(db, productId, atIso)` →
  `{price_cents, program_id, program_name}` or `null` (no override). Selection: active
  program whose `starts_on..ends_on` (local days, inclusive) covers `atIso`, containing an
  entry for the product; highest `priority` wins, tie → lowest program id.
  Routes under `/api/pricing/…` (admin/manager; `GET` list roles `[]`).
- `menus.js` exports `getActiveMenu(db)` → `{pages:[{id,name,sort,buttons:[{id,position,
  label,color,size,product_id,link_page_id, product:{name,price_cents,kind,event_id}|null}]}]}`
  (active pages/buttons only, product join included, inactive products' buttons omitted).
  Route `GET /api/menus/active` (roles `[]`); builder CRUD admin/manager.
- `storefront.js` exposes public `GET /api/store/layout` →
  `{settings:{hero_title,hero_sub,accent}, sections:[{id,title,kind,sort,
  products:[sellable-feed-shaped…]}]}` — products resolved server-side through
  `ctx.modules.catalog.getSellable(db,'web')` and `groups.productIdsInGroup`; never leak
  non-web or inactive products. Builder CRUD under `/api/storefront/…` (admin/manager);
  settings persist in the core `settings` table under `store_*` keys.
- `accounts.js` self-initializes a default chart + mappings on first mount when `accounts`
  is empty (codes: 1000 Cash Clearing, 1010 Card Clearing, 2200 Sales Tax Payable,
  4000 Admission Income, 4100 Membership Income, 4200 Addon Income, 4900 Discounts Given).
  `GET /api/accounts/journal?from=&to=` → per-day balanced entries derived from payments
  (debit clearing, net of change), income per product mapping, tax per tax-group mapping,
  discounts per mapping (debit), refunds reversed. Every day's debits MUST equal credits;
  a test asserts it over mixed activity. CSV via the shared report format.
- **Effective pricing integration (Phase C, coordinator):** `catalog.getSellable` and
  `pos.createOrder` consult `ctx.modules.pricing?.resolvePrice(db, product_id, now)` when
  the module is present; feed rows gain `base_price_cents` + `program_name` when overridden.
  Teams do NOT edit `pos.js` this wave; item-config's catalog.js work must keep
  `getSellable`'s existing return fields stable (additive only).

## Sequencing

Phase A (done by coordinator before teams): migration 003, shell nav entries, this design.
Phase B: all six teams in parallel (builder → verifier each). Dependencies are read-only
contracts; where a sibling module is absent at runtime, degrade gracefully (POS auto-grid
fallback, store static fallback, `ctx.modules.X` presence checks) — same rule as pos-mvp.
Phase C (coordinator): pricing wired into feed + order path, smoke extended (menu render,
store layout, program price honored at POS and store, journal balances), push to GitHub.
