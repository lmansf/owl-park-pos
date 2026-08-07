-- pluggable-tenders: payments.method is validated by the pos tender registry,
-- not a schema CHECK — new tenders must need no DDL. SQLite cannot alter a
-- CHECK, so recreate the table (nothing references payments; the runner wraps
-- this file in one transaction). Column set and row data are preserved.
ALTER TABLE payments RENAME TO payments_old;
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL CHECK(length(method) > 0),
  amount_cents INTEGER NOT NULL,
  change_cents INTEGER NOT NULL DEFAULT 0,
  ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO payments (id, order_id, method, amount_cents, change_cents, ref, created_at)
  SELECT id, order_id, method, amount_cents, change_cents, ref, created_at FROM payments_old;
DROP TABLE payments_old;
CREATE INDEX idx_payments_order ON payments(order_id);
