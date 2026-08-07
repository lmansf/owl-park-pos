'use strict';
// store — anonymous guest storefront APIs. All selling logic is DELEGATED:
// pricing/discounts via ctx.modules.pos.createOrder, posting/capacity/tickets/members
// via ctx.modules.pos.finalizeOrder, sellable feed via ctx.modules.catalog.getSellable,
// discount lookup via ctx.modules.catalog.validateDiscount. No rule lives twice.
const { ApiError } = require('../core/http');
const { tx } = require('../core/db');
const { randomCode } = require('../core/auth');

function bad(code, message) {
  return new ApiError(400, code, message);
}

function uniqueConfirmation(db) {
  for (let i = 0; i < 25; i++) {
    const code = 'W-' + randomCode('', 9);
    if (!db.prepare('SELECT 1 FROM orders WHERE confirmation = ?').get(code)) return code;
  }
  throw new Error('could not allocate unique confirmation');
}

// Simulated card: well-formed = 12-19 digits after stripping spaces/dashes.
// Digits ending '0002' (the 4000 0000 0000 0002 test number) decline.
function checkCard(card) {
  const digits = String(card?.number || '').replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits)) {
    throw bad('bad_card', 'Card number must be 12-19 digits');
  }
  if (digits.endsWith('0002')) {
    throw new ApiError(402, 'payment_declined', 'Card declined — try a different card');
  }
  return digits;
}

function sessionView(s) {
  return {
    id: s.id,
    event_id: s.event_id,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    capacity: s.capacity,
    sold: s.sold,
    remaining: s.capacity - s.sold,
    sold_out: s.capacity - s.sold <= 0,
  };
}

// Guest-safe order view: order + lines + tickets (+ members for membership lines).
function guestOrderView(db, order) {
  const lines = db
    .prepare(
      `SELECT ol.id, ol.description, ol.qty, ol.unit_price_cents, ol.discount_cents,
              ol.tax_cents, ol.line_total_cents, ol.event_session_id, ol.member_id,
              ol.member_intent,
              p.kind AS product_kind, p.name AS product_name, p.membership_program_id,
              s.starts_at AS session_starts_at, s.ends_at AS session_ends_at,
              e.name AS event_name
       FROM order_lines ol
       JOIN products p ON p.id = ol.product_id
       LEFT JOIN event_sessions s ON s.id = ol.event_session_id
       LEFT JOIN events e ON e.id = s.event_id
       WHERE ol.order_id = ? ORDER BY ol.id`
    )
    .all(order.id);

  const tickets = db
    .prepare(
      `SELECT t.code, t.status, t.uses_remaining, t.valid_from, t.valid_to, t.holder_name,
              ol.description, p.name AS product_name,
              s.starts_at AS session_starts_at, s.ends_at AS session_ends_at,
              e.name AS event_name
       FROM tickets t
       JOIN order_lines ol ON ol.id = t.order_line_id
       JOIN products p ON p.id = t.product_id
       LEFT JOIN event_sessions s ON s.id = t.event_session_id
       LEFT JOIN events e ON e.id = s.event_id
       WHERE ol.order_id = ? ORDER BY t.id`
    )
    .all(order.id);

  // Membership lines: resolve the member the shared posting path created/renewed —
  // finalize stamps order_lines.member_id, so it is a plain join. Rows from before
  // the member-order-lines migration may have no member_id; the backfilled
  // member_intent email (the gift recipient on "(for ...)" lines) or, failing that,
  // the order email identifies the member, so look it up by that.
  const members = [];
  const seen = new Set();
  for (const l of lines) {
    if (l.product_kind !== 'membership') continue;
    let member = null;
    if (l.member_id) {
      member = db.prepare('SELECT * FROM members WHERE id = ?').get(l.member_id);
    } else {
      let email = '';
      if (l.member_intent) {
        try {
          email = String(JSON.parse(l.member_intent).email || '').trim();
        } catch {
          email = '';
        }
      }
      if (!email && order.customer_email) email = String(order.customer_email).trim();
      if (email) {
        member = db
          .prepare(
            `SELECT * FROM members WHERE lower(email) = lower(?) AND program_id = ?
             ORDER BY id LIMIT 1`
          )
          .get(email, l.membership_program_id);
      }
    }
    // Reveal gate: a pass (incl. its gate credential) is only shown when the member's
    // email matches the order email, or the member was minted by this very order —
    // an arbitrary member id on a line must never leak someone else's pass code.
    if (
      member &&
      String(member.email).toLowerCase() !== String(order.customer_email).toLowerCase() &&
      Date.parse(member.joined_at) < Date.parse(order.created_at)
    ) {
      member = null;
    }
    if (member && !seen.has(member.id)) {
      seen.add(member.id);
      members.push({
        member_no: member.member_no,
        name: member.name,
        pass_code: member.pass_code,
        expires_at: member.expires_at,
        status: member.status,
      });
    }
  }
  // internal member ids stay out of the guest view (pass cards carry member_no)
  for (const l of lines) {
    delete l.member_id;
    delete l.member_intent;
  }

  return {
    id: order.id,
    confirmation: order.confirmation,
    status: order.status,
    channel: order.channel,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    discount_code: order.discount_code,
    subtotal_cents: order.subtotal_cents,
    discount_cents: order.discount_cents,
    tax_cents: order.tax_cents,
    total_cents: order.total_cents,
    created_at: order.created_at,
    paid_at: order.paid_at,
    lines,
    tickets,
    members,
  };
}

function mount(router, ctx) {
  const db = ctx.db;

  // Everything a guest needs to render the store: web-sellable products, active
  // events referenced by those products, and their upcoming (non-cancelled) sessions.
  router.get('/api/store/catalog', null, () => {
    const products = ctx.modules.catalog.getSellable(db, 'web');
    const eventIds = [...new Set(products.map((p) => p.event_id).filter((id) => id != null))];
    const events = [];
    const sessions = [];
    const nowIso = new Date().toISOString();
    for (const id of eventIds) {
      const ev = db
        .prepare('SELECT id, name, description FROM events WHERE id = ? AND active = 1')
        .get(id);
      if (!ev) continue;
      events.push(ev);
      for (const s of db
        .prepare(
          `SELECT * FROM event_sessions
           WHERE event_id = ? AND cancelled = 0 AND starts_at >= ?
           ORDER BY starts_at LIMIT 200`
        )
        .all(id, nowIso)) {
        sessions.push(sessionView(s));
      }
    }
    const venue = db.prepare("SELECT value FROM settings WHERE key = 'venue_name'").get();
    return { venue: venue ? venue.value : 'Owl Park', products, events, sessions };
  });

  // Anonymous discount pre-check for the cart (catalog's own validate route needs a
  // session; the lookup itself is the same shared catalog.validateDiscount).
  router.post('/api/store/validate-discount', null, (req) => {
    const discount = ctx.modules.catalog.validateDiscount(db, req.body?.code);
    if (!discount) throw new ApiError(404, 'bad_discount', 'Invalid or inactive discount code');
    return {
      discount: { code: discount.code, name: discount.name, kind: discount.kind, value: discount.value },
    };
  });

  // Checkout: validate guest + card first (a declined card must write NOTHING),
  // then one transaction around the shared createOrder + finalizeOrder posting path —
  // a capacity failure rolls the whole order back.
  router.post('/api/store/checkout', null, (req) => {
    const b = req.body || {};
    const name = String(b.customer?.name || '').trim();
    const email = String(b.customer?.email || '').trim();
    if (!name) throw bad('name_required', 'Please enter your name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw bad('email_required', 'Please enter a valid email address');
    }
    const cardDigits = checkCard(b.card);

    const result = tx(db, () => {
      const order = ctx.modules.pos.createOrder(
        db,
        ctx,
        {
          lines: b.lines,
          discount_code: b.discount_code,
          customer: { name, email },
          confirmation: uniqueConfirmation(db),
        },
        'web'
      );
      return ctx.modules.pos.finalizeOrder(db, ctx, order.id, [
        {
          method: 'card_sim',
          amount_cents: order.total_cents,
          ref: 'CARD-' + cardDigits.slice(-4),
        },
      ]);
    });

    return {
      confirmation: result.order.confirmation,
      order: guestOrderView(db, result.order),
    };
  });

  // Later retrieval: order code AND email must both match; anything else is a plain
  // not-found (no data leaks about which half was wrong).
  router.get('/api/store/order', null, (req) => {
    const code = String(req.query.code || '').trim();
    const email = String(req.query.email || '').trim();
    const order = code
      ? db.prepare('SELECT * FROM orders WHERE confirmation = ? COLLATE NOCASE').get(code)
      : null;
    if (!order || !email || order.customer_email.toLowerCase() !== email.toLowerCase()) {
      throw new ApiError(404, 'not_found', 'No order matches that code and email');
    }
    return { order: guestOrderView(db, order) };
  });
}

module.exports = { mount };
