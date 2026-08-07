'use strict';
const { hashPassword, randomCode } = require('./auth');
const { tx, now } = require('./db');

// Idempotent demo seed: runs only when there are no users.
function seed(db) {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasUsers) return false;

  tx(db, () => {
    const iso = now();

    for (const [username, role, name] of [
      ['admin', 'admin', 'Ada Admin'],
      ['manager', 'manager', 'Morgan Manager'],
      ['cashier', 'cashier', 'Casey Cashier'],
      ['gate', 'gate', 'Gabi Gate'],
    ]) {
      // Well-known demo passwords: flagged for forced rotation, enforced only
      // when the server runs in production mode.
      db.prepare(
        'INSERT INTO users (username, pass_hash, display_name, role, must_change_password) VALUES (?, ?, ?, ?, 1)'
      ).run(username, hashPassword(username), name, role);
    }

    db.prepare("INSERT INTO settings (key, value) VALUES ('venue_name', 'Owl Park')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('currency', 'USD')").run();

    const tax = db.prepare('INSERT INTO tax_groups (name, rate_bp) VALUES (?, ?)');
    tax.run('Admissions 6.25%', 625);
    tax.run('Non-taxable', 0);

    const prog = db.prepare(
      'INSERT INTO membership_programs (name, duration_days, benefits) VALUES (?, ?, ?)'
    );
    prog.run('Explorer Annual', 365, 'Unlimited general admission for one year');
    prog.run('Nova Family Annual', 365, 'Unlimited admission + guest pass + shop discount');

    db.prepare("INSERT INTO events (name, description) VALUES ('Planetarium Show', 'Timed-entry dome show, 40 seats')").run();
    const eventId = db.prepare("SELECT id FROM events WHERE name = 'Planetarium Show'").get().id;

    // Sessions: next 14 days, 10:00–17:30 local, every 90 min, capacity 40
    const insSession = db.prepare(
      'INSERT INTO event_sessions (event_id, starts_at, ends_at, capacity) VALUES (?, ?, ?, ?)'
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let d = 0; d < 14; d++) {
      for (let slot = 0; slot < 6; slot++) {
        const start = new Date(today.getTime() + d * (24 * 3600 * 1000));
        start.setHours(10, 0, 0, 0);
        start.setMinutes(start.getMinutes() + slot * 90);
        const end = new Date(start.getTime() + 45 * 60_000);
        insSession.run(eventId, start.toISOString(), end.toISOString(), 40);
      }
    }

    const insProduct = db.prepare(
      `INSERT INTO products (sku, name, kind, price_cents, tax_group_id, event_id,
        membership_program_id, validity_days, max_uses, channels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insProduct.run('ADULT', 'Adult Day Ticket', 'ticket', 2995, 1, null, null, 30, 1, 'pos,web');
    insProduct.run('CHILD', 'Child Day Ticket (3-12)', 'ticket', 1595, 1, null, null, 30, 1, 'pos,web');
    insProduct.run('SENIOR', 'Senior Day Ticket (65+)', 'ticket', 2195, 1, null, null, 30, 1, 'pos,web');
    insProduct.run('PLNTM', 'Planetarium Show (timed)', 'ticket', 900, 1, eventId, null, 30, 1, 'pos,web');
    insProduct.run('PARK', 'Parking Pass', 'addon', 1200, 2, null, null, 1, 1, 'pos,web');
    insProduct.run('MEM-EXP', 'Explorer Annual Membership', 'membership', 9900, 2, null, 1, 365, 1, 'pos,web');
    insProduct.run('MEM-NOVA', 'Nova Family Annual Membership', 'membership', 15900, 2, null, 2, 365, 1, 'pos,web');

    db.prepare(
      "INSERT INTO discounts (code, name, kind, value) VALUES ('SAVE10', '10% Promo', 'percent', 10)"
    ).run();

    // One demo member so the gate/members pages aren't empty on first run
    db.prepare(
      `INSERT INTO members (member_no, name, email, program_id, pass_code, joined_at, expires_at)
       VALUES (?, 'Dana Demo', 'dana@example.com', 1, ?, ?, ?)`
    ).run(
      'GM-' + randomCode('', 6),
      randomCode('M-', 10),
      iso,
      new Date(Date.now() + 365 * (24 * 3600 * 1000)).toISOString()
    );
  });
  return true;
}

module.exports = { seed };
