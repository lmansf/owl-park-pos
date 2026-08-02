CREATE TABLE item_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE product_groups (
  product_id INTEGER NOT NULL REFERENCES products(id),
  group_id INTEGER NOT NULL REFERENCES item_groups(id),
  PRIMARY KEY (product_id, group_id)
);

CREATE TABLE menu_pages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE menu_buttons (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES menu_pages(id),
  position INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL CHECK(size IN ('sm','md','lg')) DEFAULT 'md',
  product_id INTEGER REFERENCES products(id),
  link_page_id INTEGER REFERENCES menu_pages(id),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_menu_buttons_page ON menu_buttons(page_id, position);

CREATE TABLE store_sections (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('hero','products','groups','html')),
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('asset','liability','income','expense','clearing')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE account_map (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('product','tax_group','tender','discount')),
  ref_key TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  UNIQUE (scope, ref_key)
);

CREATE TABLE price_programs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE price_program_entries (
  program_id INTEGER NOT NULL REFERENCES price_programs(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  price_cents INTEGER NOT NULL,
  PRIMARY KEY (program_id, product_id)
);
