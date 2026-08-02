CREATE TABLE tax_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rate_bp INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE membership_programs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  benefits TEXT NOT NULL DEFAULT ''
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE event_sessions (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  sold INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_event_sessions_event_start ON event_sessions(event_id, starts_at);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ticket','membership','addon')),
  price_cents INTEGER NOT NULL,
  tax_group_id INTEGER NOT NULL REFERENCES tax_groups(id),
  event_id INTEGER REFERENCES events(id),
  membership_program_id INTEGER REFERENCES membership_programs(id),
  validity_days INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER NOT NULL DEFAULT 1,
  channels TEXT NOT NULL DEFAULT 'pos,web',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE discounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('percent','amount')),
  value INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  confirmation TEXT UNIQUE,
  channel TEXT NOT NULL CHECK(channel IN ('pos','web')),
  status TEXT NOT NULL CHECK(status IN ('open','paid','void','refunded')) DEFAULT 'open',
  cashier_id INTEGER REFERENCES users(id),
  customer_name TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  discount_code TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  refunded_at TEXT
);

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  description TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  event_session_id INTEGER REFERENCES event_sessions(id)
);
CREATE INDEX idx_order_lines_order ON order_lines(order_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL CHECK(method IN ('cash','card_sim')),
  amount_cents INTEGER NOT NULL,
  change_cents INTEGER NOT NULL DEFAULT 0,
  ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_payments_order ON payments(order_id);

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  member_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  program_id INTEGER NOT NULL REFERENCES membership_programs(id),
  pass_code TEXT NOT NULL UNIQUE,
  joined_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','suspended')) DEFAULT 'active'
);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  event_session_id INTEGER REFERENCES event_sessions(id),
  status TEXT NOT NULL CHECK(status IN ('valid','used','void')) DEFAULT 'valid',
  uses_remaining INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  holder_name TEXT NOT NULL DEFAULT ''
);

CREATE TABLE admits (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ticket','member','unknown')),
  ticket_id INTEGER REFERENCES tickets(id),
  member_id INTEGER REFERENCES members(id),
  gate TEXT NOT NULL DEFAULT 'main',
  result TEXT NOT NULL CHECK(result IN ('ok','denied')),
  reason TEXT
);
CREATE INDEX idx_admits_at ON admits(at);
