-- member-order-lines: structured member references on order lines.
-- member_id: existing member (renewal target, or stamped at finalize once posted).
-- member_intent: server-written JSON {"name","email"} for a new member to create at
-- finalize. Both nullable; the line description becomes display-only text.

ALTER TABLE order_lines ADD COLUMN member_id INTEGER REFERENCES members(id);
ALTER TABLE order_lines ADD COLUMN member_intent TEXT;

-- Best-effort backfill from the legacy description encoding. Unparseable rows stay
-- NULL (never guess). Covers open orders too: a pre-migration open order finalized
-- post-migration must still renew the right member.

-- 1) "... (renewal #N)" -> member_id, only when member N still exists (FK must not dangle)
UPDATE order_lines
SET member_id = CAST(substr(description, instr(description, '(renewal #') + 10) AS INTEGER)
WHERE member_id IS NULL
  AND product_id IN (SELECT id FROM products WHERE kind = 'membership')
  AND description GLOB '* (renewal #[0-9]*)'
  AND EXISTS (SELECT 1 FROM members m
              WHERE m.id = CAST(substr(description, instr(description, '(renewal #') + 10) AS INTEGER));

-- 2) "... (for Name <email>)" -> member_intent {name, email}
UPDATE order_lines
SET member_intent = json_object(
  'name',  rtrim(substr(substr(description, instr(description, ' (for ') + 6), 1,
                        instr(substr(description, instr(description, ' (for ') + 6), '<') - 1)),
  'email', substr(substr(description, instr(description, ' (for ') + 6),
                  instr(substr(description, instr(description, ' (for ') + 6), '<') + 1,
                  instr(substr(description, instr(description, ' (for ') + 6), '>')
                    - instr(substr(description, instr(description, ' (for ') + 6), '<') - 1))
WHERE member_id IS NULL AND member_intent IS NULL
  AND product_id IN (SELECT id FROM products WHERE kind = 'membership')
  AND description GLOB '* (for *<*>)';

-- 3) "... (for Name)" (no email) -> member_intent with empty email
UPDATE order_lines
SET member_intent = json_object(
  'name', rtrim(substr(substr(description, instr(description, ' (for ') + 6), 1,
                       length(substr(description, instr(description, ' (for ') + 6)) - 1)),
  'email', '')
WHERE member_id IS NULL AND member_intent IS NULL
  AND product_id IN (SELECT id FROM products WHERE kind = 'membership')
  AND description GLOB '* (for *)'
  AND description NOT GLOB '* (for *<*>*';
