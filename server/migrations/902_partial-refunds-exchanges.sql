-- migrate: foreign_keys=off
-- partial-refunds-exchanges: per-line refunds and session exchanges.
-- 1) orders gains the 'partial_refund' status. SQLite cannot ALTER a CHECK, so
--    the table is rebuilt per the official ALTER TABLE procedure; the
--    directive above makes the runner disable FK enforcement for this file and
--    run PRAGMA foreign_key_check before COMMIT instead.
-- 2) order_lines.refunded_qty tracks per-line refund progress.
-- 3) tickets.exchanged_from links a reissued ticket to the one it replaced.
-- 4) refunds/refund_lines record each refund event at line granularity; reports
--    and the GL journal derive refund legs from them.
CREATE TABLE orders_new (
  id INTEGER PRIMARY KEY,
  confirmation TEXT UNIQUE,
  channel TEXT NOT NULL CHECK(channel IN ('pos','web')),
  status TEXT NOT NULL CHECK(status IN ('open','paid','void','refunded','partial_refund')) DEFAULT 'open',
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
INSERT INTO orders_new SELECT * FROM orders;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

ALTER TABLE order_lines ADD COLUMN refunded_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN exchanged_from INTEGER REFERENCES tickets(id);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  user_id INTEGER REFERENCES users(id),
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_refunds_created ON refunds(created_at);
CREATE INDEX idx_refunds_order ON refunds(order_id);

CREATE TABLE refund_lines (
  id INTEGER PRIMARY KEY,
  refund_id INTEGER NOT NULL REFERENCES refunds(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  qty INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL
);
CREATE INDEX idx_refund_lines_refund ON refund_lines(refund_id);
CREATE INDEX idx_refund_lines_line ON refund_lines(order_line_id);

-- Backfill: each pre-existing full refund becomes one refund event covering all
-- of its lines, so the rewritten report/journal queries reproduce the numbers
-- the old refunded_at-keyed queries produced.
INSERT INTO refunds (order_id, user_id, total_cents, created_at)
  SELECT id, NULL, total_cents, refunded_at FROM orders WHERE status = 'refunded';
INSERT INTO refund_lines (refund_id, order_line_id, qty, gross_cents, discount_cents, tax_cents, total_cents)
  SELECT r.id, ol.id, ol.qty, ol.qty * ol.unit_price_cents, ol.discount_cents, ol.tax_cents, ol.line_total_cents
  FROM refunds r JOIN order_lines ol ON ol.order_id = r.order_id;
UPDATE order_lines SET refunded_qty = qty
  WHERE order_id IN (SELECT id FROM orders WHERE status = 'refunded');
