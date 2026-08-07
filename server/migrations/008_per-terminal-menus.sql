-- per-terminal-menus: named terminals a POS browser can claim, plus the
-- page-set assigned to each. A terminal with no assignment rows (or no claim
-- at all) falls through to the single default active menu.

CREATE TABLE terminals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE terminal_menu_pages (
  terminal_id INTEGER NOT NULL REFERENCES terminals(id),
  page_id INTEGER NOT NULL REFERENCES menu_pages(id),
  PRIMARY KEY (terminal_id, page_id)
);
