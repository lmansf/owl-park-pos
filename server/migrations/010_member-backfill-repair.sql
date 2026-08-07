-- Repair the 005 member backfill, which parsed the legacy description encoding by
-- searching for ' (for ' / '(renewal #' ANYWHERE in the text. A product name is free
-- text, so a membership named e.g. "Gift Membership (for a friend <gifts@owlpark.test>)"
-- had its own name read as a member reference: the line came out pointing at a stranger,
-- and finalizing it renewed that stranger's membership while the paying customer got
-- nothing. 005 is left as it shipped (it may already have run) — this migration corrects
-- what it wrote.
--
-- The parse is re-anchored: the member suffix is only ever what pos.js appended AFTER the
-- product's own name, and it always ends the string. So the trustworthy suffix is
--   substr(description, length(p.name) + 1)   -- only when the name is a literal prefix
-- and anything that is not a recognised "(for ...)" / "(renewal #N)" suffix means the line
-- carries NO member information: leave it NULL and let finalize fall back to the order
-- customer, which is strictly safer than guessing.
--
-- Scope: only lines of orders created BEFORE 005 ran. Those are exactly the rows the
-- backfill could have touched — the columns did not exist earlier, and everything since
-- was written structurally by pos.createOrder (never re-derived from text). Lines whose
-- description does not start with the current product name (renamed since the sale) are
-- left alone: nothing can be re-derived for them, and 005's value is no worse.
--
-- member_id is repaired only on OPEN orders. On a paid order it records the member the
-- posting path actually issued/renewed — history, not intent, and not ours to rewrite.

-- 1) member_intent := the anchored parse of the suffix (NULL when there is none).
WITH legacy AS (
  SELECT ol.id AS line_id, o.status AS order_status,
         substr(ol.description, length(p.name) + 1) AS sfx
  FROM order_lines ol
  JOIN products p ON p.id = ol.product_id
  JOIN orders o ON o.id = ol.order_id
  WHERE p.kind = 'membership'
    AND substr(ol.description, 1, length(p.name)) = p.name
    AND o.created_at < (SELECT applied_at FROM schema_migrations
                        WHERE name = '005_member-order-lines.sql')
)
UPDATE order_lines SET member_intent = CASE
    WHEN legacy.sfx GLOB ' (for *<*>)' THEN json_object(
      'name',  rtrim(substr(legacy.sfx, 7, instr(legacy.sfx, '<') - 7)),
      'email', substr(legacy.sfx, instr(legacy.sfx, '<') + 1,
                      length(legacy.sfx) - instr(legacy.sfx, '<') - 2))
    WHEN legacy.sfx GLOB ' (for *)' THEN json_object(
      'name',  rtrim(substr(legacy.sfx, 7, length(legacy.sfx) - 7)),
      'email', '')
    ELSE NULL
  END
FROM legacy WHERE legacy.line_id = order_lines.id;

-- 2) member_id on still-open orders := the anchored renewal target, and only when that
-- member still exists (the FK must not dangle); otherwise NULL.
WITH legacy AS (
  SELECT ol.id AS line_id,
         substr(ol.description, length(p.name) + 1) AS sfx
  FROM order_lines ol
  JOIN products p ON p.id = ol.product_id
  JOIN orders o ON o.id = ol.order_id
  WHERE p.kind = 'membership'
    AND o.status = 'open'
    AND substr(ol.description, 1, length(p.name)) = p.name
    AND o.created_at < (SELECT applied_at FROM schema_migrations
                        WHERE name = '005_member-order-lines.sql')
)
UPDATE order_lines SET member_id = (
    SELECT m.id FROM members m
    WHERE legacy.sfx GLOB ' (renewal #[0-9]*)'
      AND m.id = CAST(substr(legacy.sfx, 12, length(legacy.sfx) - 12) AS INTEGER)
  )
FROM legacy WHERE legacy.line_id = order_lines.id;
