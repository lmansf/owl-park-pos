-- drawer-sessions-zreports: per-cashier cash-drawer sessions (open float,
-- paid-in/out movements, blind close with over/short + sequential Z numbers)
-- and drawer attribution on payments. Modules write no DDL; this file is the
-- only schema for the drawer module.
CREATE TABLE drawer_sessions (
  id INTEGER PRIMARY KEY,
  terminal TEXT NOT NULL DEFAULT 'main',
  opened_by INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL,
  open_float_cents INTEGER NOT NULL CHECK(open_float_cents >= 0),
  status TEXT NOT NULL CHECK(status IN ('open','closed')) DEFAULT 'open',
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  counted_cents INTEGER,
  expected_cents INTEGER,
  over_short_cents INTEGER,
  close_note TEXT NOT NULL DEFAULT '',
  z_number INTEGER UNIQUE
);
-- Backstop for the application-level check: at most one OPEN session per user.
CREATE UNIQUE INDEX idx_drawer_open_user ON drawer_sessions(opened_by) WHERE status = 'open';

CREATE TABLE drawer_movements (
  id INTEGER PRIMARY KEY,
  drawer_session_id INTEGER NOT NULL REFERENCES drawer_sessions(id),
  kind TEXT NOT NULL CHECK(kind IN ('paid_in','paid_out')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  reason TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_drawer_movements_session ON drawer_movements(drawer_session_id);

-- Payment attribution: which drawer session took/returned this money.
-- NULL for web-channel payments and pre-drawer history.
ALTER TABLE payments ADD COLUMN drawer_session_id INTEGER REFERENCES drawer_sessions(id);
CREATE INDEX idx_payments_drawer ON payments(drawer_session_id);
