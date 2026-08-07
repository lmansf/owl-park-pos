'use strict';
// Migration 010 repairs what the 005 member backfill mis-parsed. 005 searched the
// whole line description for ' (for ' / '(renewal #', so a membership product whose
// NAME contains such a clause had its own name read as a member reference.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../server/main');
const { migrate } = require('../server/core/db');

const MIGRATIONS = path.join(__dirname, '..', 'server', 'migrations');
const REPAIR = '010_member-backfill-repair.sql';
const LEGACY_CREATED_AT = '2020-01-01T00:00:00.000Z'; // long before 005 ran

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  return path.join(dir, 'test.db');
}

// 005's backfill UPDATEs only (its ALTERs already ran on this DB): replays exactly
// what an upgraded pre-005 database was left holding.
function runLegacyBackfill(db) {
  const sql = fs
    .readFileSync(path.join(MIGRATIONS, '005_member-order-lines.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('ALTER TABLE'))
    .join('\n');
  db.exec(sql);
}

function rerunRepair(db) {
  db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(REPAIR);
  migrate(db, MIGRATIONS); // only the un-applied 010 runs again
}

test('migration 010: repairs the 005 member backfill mis-parse', async (t) => {
  const { server, db, ctx } = createApp(tempDb());
  t.after(() => server.close());
  const pos = ctx.modules.pos;

  const gift = db.prepare("SELECT * FROM products WHERE sku = 'MEM-EXP'").get();
  const nova = db.prepare("SELECT * FROM products WHERE sku = 'MEM-NOVA'").get();
  // free-text product names, exactly as the catalog editor accepts them
  db.prepare('UPDATE products SET name = ? WHERE id = ?')
    .run('Gift Membership (for a friend <gifts@owlpark.test>)', gift.id);

  // an unrelated, pre-existing member whose address is in that product name
  const desk = ctx.modules.membership.createOrRenewMember(db, {
    program_id: gift.membership_program_id,
    name: 'Park Gift Desk',
    email: 'gifts@owlpark.test',
  });

  // A pre-005 order line: description is the product name, structured columns absent.
  function legacyLine(product, member) {
    const order = pos.createOrder(db, ctx, {
      lines: [{ product_id: product.id, qty: 1, ...(member ? { member } : {}) }],
      customer: { name: 'Real Customer', email: 'real@customer.com' },
    }, 'pos');
    db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(LEGACY_CREATED_AT, order.id);
    db.prepare('UPDATE order_lines SET member_id = NULL, member_intent = NULL WHERE order_id = ?')
      .run(order.id);
    return { order, lineId: db.prepare('SELECT id FROM order_lines WHERE order_id = ?').get(order.id).id };
  }
  const line = (id) => db.prepare('SELECT * FROM order_lines WHERE id = ?').get(id);

  const plain = legacyLine(gift);                                           // name only
  const gifted = legacyLine(gift, { name: 'Bob Buyer', email: 'bob@example.com' });
  db.prepare('UPDATE products SET name = ? WHERE id = ?')
    .run(`Legacy Membership (renewal #${desk.id})`, nova.id);
  const renewalish = legacyLine(nova);

  await t.test('005 alone reads the product name as a member reference', () => {
    runLegacyBackfill(db);
    assert.deepEqual(JSON.parse(line(plain.lineId).member_intent),
      { name: 'a friend', email: 'gifts@owlpark.test' });
    // the genuine "(for Bob Buyer <bob@example.com>)" suffix loses to the name's clause
    assert.deepEqual(JSON.parse(line(gifted.lineId).member_intent),
      { name: 'a friend', email: 'gifts@owlpark.test' });
    assert.equal(line(renewalish.lineId).member_id, desk.id);
  });

  await t.test('010 re-anchors the parse to the suffix after the product name', () => {
    rerunRepair(db);
    assert.equal(line(plain.lineId).member_intent, null, 'no suffix -> no member info');
    assert.deepEqual(JSON.parse(line(gifted.lineId).member_intent),
      { name: 'Bob Buyer', email: 'bob@example.com' });
    assert.equal(line(renewalish.lineId).member_id, null, 'not a real renewal target');
  });

  await t.test('the paying customer gets the membership, not the stranger', () => {
    const before = db.prepare('SELECT expires_at FROM members WHERE id = ?').get(desk.id).expires_at;
    const res = pos.finalizeOrder(db, ctx, plain.order.id, [
      { method: 'card_sim', amount_cents: plain.order.total_cents },
    ]);
    assert.equal(res.members.length, 1);
    assert.equal(res.members[0].email, 'real@customer.com');
    assert.notEqual(res.members[0].id, desk.id);
    assert.equal(db.prepare('SELECT expires_at FROM members WHERE id = ?').get(desk.id).expires_at,
      before, "the gift desk's membership was not extended");

    // the gift line still delivers to the person it names
    const g = pos.finalizeOrder(db, ctx, gifted.order.id, [
      { method: 'card_sim', amount_cents: gifted.order.total_cents },
    ]);
    assert.equal(g.members[0].email, 'bob@example.com');
  });

  await t.test('structured rows written after 005 are left alone', () => {
    // same dangerous product name, but a current order: pos.createOrder wrote the
    // columns directly and 010 must not second-guess them.
    const order = pos.createOrder(db, ctx, {
      lines: [{ product_id: gift.id, qty: 1, member: { name: 'Nia New', email: 'nia@example.com' } }],
      customer: { name: 'Real Customer', email: 'real@customer.com' },
    }, 'pos');
    const lineId = db.prepare('SELECT id FROM order_lines WHERE order_id = ?').get(order.id).id;
    const intent = line(lineId).member_intent;
    rerunRepair(db);
    assert.equal(line(lineId).member_intent, intent);
    assert.deepEqual(JSON.parse(line(lineId).member_intent),
      { name: 'Nia New', email: 'nia@example.com' });
  });

  await t.test('a paid legacy line keeps the member it actually issued', () => {
    // member_id on a paid line is history (what finalize did), not intent
    const paidLineId = db.prepare('SELECT id FROM order_lines WHERE order_id = ?')
      .get(plain.order.id).id;
    const issued = line(paidLineId).member_id;
    assert.ok(issued);
    db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(LEGACY_CREATED_AT, plain.order.id);
    rerunRepair(db);
    assert.equal(line(paidLineId).member_id, issued);
  });
});
