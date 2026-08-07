-- Every member a membership order line actually posted at finalize, one row per unit.
-- order_lines.member_id can hold only ONE member, but a qty>1 line posts one member
-- per unit, so the single stamp lost every member but the last: a full refund left the
-- earlier passes admitting forever, and the guest view under-delivered pass cards.
-- finalizeOrder writes one row per unit ('minted' = a member this order created,
-- 'renewed' = an existing member extended); refundOrder reverses the most recently
-- posted unreversed rows first, and the order/guest views list every member on the
-- line. member_id stays stamped with the last posted member for anything still
-- joining through it.
CREATE TABLE order_line_members (
  id INTEGER PRIMARY KEY,
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  action TEXT NOT NULL CHECK(action IN ('minted','renewed'))
);
CREATE INDEX idx_order_line_members_line ON order_line_members(order_line_id);

-- Backfill posted membership lines from the single stamped member: qty rows per line,
-- reproducing what the pre-link posting path actually did — a member the order minted
-- (joined_at not before paid_at) took unit 1 as its creation and every further unit as
-- a renewal of it; a pre-existing member was renewed by every unit. The 'minted' row
-- is inserted first so reversal (newest row first) gives back renewal durations before
-- suspending the pass. Open orders are skipped: their member_id is a renewal TARGET,
-- not a posting record — finalize writes their rows when they post.
WITH RECURSIVE seq(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seq
  WHERE n < (SELECT COALESCE(MAX(qty), 1) FROM order_lines)
)
INSERT INTO order_line_members (order_line_id, member_id, action)
SELECT ol.id, ol.member_id,
       CASE WHEN seq.n = 1 AND m.joined_at >= o.paid_at THEN 'minted' ELSE 'renewed' END
FROM order_lines ol
JOIN orders o ON o.id = ol.order_id
JOIN products p ON p.id = ol.product_id
JOIN members m ON m.id = ol.member_id
JOIN seq ON seq.n <= ol.qty
WHERE p.kind = 'membership' AND o.paid_at IS NOT NULL
ORDER BY ol.id, seq.n;
