'use strict';
// pos — order creation + pricing, THE shared posting path (finalizeOrder), void/refund.
// finalizeOrder is the ONLY code path that marks orders paid, issues tickets and
// mutates event_sessions.sold — the online store must call it too.
const { ApiError } = require('../core/http');
const { tx, now } = require('../core/db');
const { audit, randomCode, verifyManagerCredential, createRateLimiter } = require('../core/auth');

const SELL = ['cashier', 'manager', 'admin'];
const DAY_MS = (24 * 3600 * 1000);

function bad(code, message) {
  return new ApiError(400, code, message);
}

function uniqueTicketCode(db) {
  for (let i = 0; i < 25; i++) {
    const code = randomCode('T-', 10);
    if (!db.prepare('SELECT 1 FROM tickets WHERE code = ?').get(code)) return code;
  }
  throw new Error('could not allocate unique ticket code');
}

function uniqueConfirmation(db, prefix) {
  for (let i = 0; i < 25; i++) {
    const code = prefix + randomCode('', 9);
    if (!db.prepare('SELECT 1 FROM orders WHERE confirmation = ?').get(code)) return code;
  }
  throw new Error('could not allocate unique confirmation');
}

// order_lines has no member column, so explicit member info for membership lines is
// encoded in the (human-readable) line description and parsed back at finalize:
//   "Explorer Annual Membership (renewal #12)"
//   "Explorer Annual Membership (for Pat Smith <pat@example.com>)"
// Only kind='membership' lines are ever parsed.
function memberSuffix(member) {
  if (!member) return '';
  if (member.member_id) return ` (renewal #${Number(member.member_id)})`;
  const name = String(member.name || '').replace(/[<>()]/g, '').trim();
  const email = String(member.email || '').replace(/[<>()]/g, '').trim();
  if (!name && !email) return '';
  return ` (for ${name}${email ? ` <${email}>` : ''})`;
}

function parseMember(description) {
  let m = description.match(/\(renewal #(\d+)\)\s*$/);
  if (m) return { member_id: Number(m[1]) };
  m = description.match(/\(for ([^<>()]*?)(?:\s*<([^<>()]*)>)?\)\s*$/);
  if (m) return { name: m[1].trim(), email: (m[2] || '').trim() };
  return null;
}

// Full order view: order row + lines + payments + tickets.
function getOrderDetail(db, id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  order.lines = db
    .prepare(
      `SELECT ol.*, p.kind AS product_kind, p.sku, s.starts_at AS session_starts_at
       FROM order_lines ol
       JOIN products p ON p.id = ol.product_id
       LEFT JOIN event_sessions s ON s.id = ol.event_session_id
       WHERE ol.order_id = ? ORDER BY ol.id`
    )
    .all(id);
  order.payments = db
    .prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id')
    .all(id);
  order.tickets = db
    .prepare(
      `SELECT t.*, ol.description AS line_description,
              s.starts_at AS session_starts_at, s.ends_at AS session_ends_at
       FROM tickets t
       JOIN order_lines ol ON ol.id = t.order_line_id
       LEFT JOIN event_sessions s ON s.id = t.event_session_id
       WHERE ol.order_id = ? ORDER BY t.id`
    )
    .all(id);
  return order;
}

// Create an 'open' order + priced lines. Shared with the online store:
// ctx.modules.pos.createOrder(db, ctx, {lines, discount_code, customer, cashier_id,
// confirmation?}, channel). Pricing: unit price from products; discount allocated
// proportionally across lines; tax per line on the discounted amount:
// round(amount * rate_bp / 10000); order totals are the sums.
function createOrder(db, ctx, payload, channel) {
  if (channel !== 'pos' && channel !== 'web') throw bad('bad_channel', 'channel must be pos or web');
  const rawLines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (!rawLines.length) throw bad('empty_order', 'Order needs at least one line');

  const sellable = new Map(ctx.modules.catalog.getSellable(db, channel).map((p) => [p.id, p]));

  let discount = null;
  const code = String(payload?.discount_code || '').trim();
  if (code) {
    discount = ctx.modules.catalog.validateDiscount(db, code);
    if (!discount) throw bad('bad_discount', `Invalid or inactive discount code "${code}"`);
  }

  const lines = rawLines.map((raw) => {
    const product = sellable.get(Number(raw?.product_id));
    if (!product) {
      throw bad('bad_product', `Product ${raw?.product_id} is not sellable on ${channel}`);
    }
    const qty = Number(raw?.qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 999) {
      throw bad('bad_qty', 'qty must be an integer between 1 and 999');
    }
    let sessionId = null;
    if (product.event_id != null) {
      sessionId = Number(raw?.event_session_id);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        throw bad('session_required', `${product.name} requires an event session`);
      }
      const s = ctx.modules.events.getSession(db, sessionId);
      if (!s || s.cancelled || s.event_id !== product.event_id) {
        throw bad('bad_session', `Session ${sessionId} is not valid for ${product.name}`);
      }
    }
    let member = null;
    if (product.kind === 'membership' && raw?.member && typeof raw.member === 'object') {
      if (raw.member.member_id) {
        const mid = Number(raw.member.member_id);
        if (!Number.isInteger(mid) || !db.prepare('SELECT 1 FROM members WHERE id = ?').get(mid)) {
          throw bad('bad_member', `No member ${raw.member.member_id}`);
        }
        member = { member_id: mid };
      } else {
        member = { name: raw.member.name, email: raw.member.email };
      }
    }
    return { product, qty, sessionId, member, gross: qty * product.price_cents };
  });

  const subtotal = lines.reduce((a, l) => a + l.gross, 0);
  const totalDiscount = !discount
    ? 0
    : discount.kind === 'percent'
      ? Math.round((subtotal * discount.value) / 100)
      : Math.min(discount.value, subtotal);

  // Proportional allocation on a shrinking remainder: sums exactly, never negative.
  let remD = totalDiscount;
  let remSub = subtotal;
  let taxTotal = 0;
  for (const l of lines) {
    l.discount = remSub > 0 ? Math.round((remD * l.gross) / remSub) : 0;
    remD -= l.discount;
    remSub -= l.gross;
    l.tax = Math.round(((l.gross - l.discount) * l.product.tax_rate_bp) / 10000);
    l.total = l.gross - l.discount + l.tax;
    taxTotal += l.tax;
  }
  const total = subtotal - totalDiscount + taxTotal;

  const customer = payload?.customer || {};
  return tx(db, () => {
    const info = db
      .prepare(
        `INSERT INTO orders (confirmation, channel, status, cashier_id, customer_name,
           customer_email, discount_code, subtotal_cents, discount_cents, tax_cents,
           total_cents, created_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload?.confirmation ?? null,
        channel,
        payload?.cashier_id ?? null,
        String(customer.name || '').trim(),
        String(customer.email || '').trim(),
        discount ? discount.code : null,
        subtotal,
        totalDiscount,
        taxTotal,
        total,
        now()
      );
    const orderId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO order_lines (order_id, product_id, description, qty, unit_price_cents,
         discount_cents, tax_cents, line_total_cents, event_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      const desc =
        l.product.name + (l.product.kind === 'membership' ? memberSuffix(l.member) : '');
      ins.run(
        orderId, l.product.id, desc, l.qty, l.product.price_cents,
        l.discount, l.tax, l.total, l.sessionId
      );
    }
    return getOrderDetail(db, orderId);
  });
}

// The shared posting path. payments = [{method:'cash'|'card_sim', amount_cents, ref?}].
// One tx: tender check, capacity reserve per session line, ticket issuance, membership
// create/renew, order -> paid, payments rows, audit. -> {order, tickets, members, change_cents}
function finalizeOrder(db, ctx, orderId, payments) {
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new ApiError(404, 'not_found', `No order ${orderId}`);
    if (order.status !== 'open') {
      throw new ApiError(409, 'order_not_open', `Order is ${order.status}, not open`);
    }

    const lines = db
      .prepare(
        `SELECT ol.*, p.kind, p.validity_days, p.max_uses, p.membership_program_id
         FROM order_lines ol JOIN products p ON p.id = ol.product_id
         WHERE ol.order_id = ? ORDER BY ol.id`
      )
      .all(orderId);

    // --- tender validation --------------------------------------------------
    const rawPays = Array.isArray(payments) ? payments : [];
    let sum = 0;
    let cashSum = 0;
    const pays = rawPays.map((p) => {
      const method = p?.method;
      if (method !== 'cash' && method !== 'card_sim') {
        throw bad('bad_method', 'Payment method must be cash or card_sim');
      }
      const amount = Number(p?.amount_cents);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw bad('bad_amount', 'amount_cents must be a positive integer');
      }
      sum += amount;
      if (method === 'cash') cashSum += amount;
      const ref =
        method === 'card_sim'
          ? String(p?.ref || '').trim() || 'AUTH-' + randomCode('', 6)
          : String(p?.ref || '').trim();
      return { method, amount, ref };
    });
    if (sum < order.total_cents) {
      throw bad(
        'insufficient_tender',
        `Tendered ${sum} of ${order.total_cents} cents — cannot finalize`
      );
    }
    const change = sum - order.total_cents;
    if (change > cashSum) {
      throw bad('bad_tender', 'Change cannot exceed cash tendered — reduce the card amount');
    }

    const at = now();

    // --- capacity: reserve per session line (throws 409 'capacity' -> full rollback)
    for (const l of lines) {
      if (l.event_session_id != null) {
        ctx.modules.events.reserveCapacity(db, l.event_session_id, l.qty);
      }
    }

    // --- tickets: one per qty on kind='ticket' lines -------------------------
    const insTicket = db.prepare(
      `INSERT INTO tickets (code, order_line_id, product_id, event_session_id, status,
         uses_remaining, valid_from, valid_to, holder_name)
       VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?)`
    );
    for (const l of lines) {
      if (l.kind !== 'ticket') continue;
      const validTo = new Date(Date.parse(at) + l.validity_days * DAY_MS).toISOString();
      for (let i = 0; i < l.qty; i++) {
        insTicket.run(
          uniqueTicketCode(db), l.id, l.product_id, l.event_session_id,
          l.max_uses, at, validTo, order.customer_name || ''
        );
      }
    }

    // --- memberships: create or renew via the membership module --------------
    const members = [];
    for (const l of lines) {
      if (l.kind !== 'membership') continue;
      const parsed = parseMember(l.description) || {};
      for (let i = 0; i < l.qty; i++) {
        members.push(
          ctx.modules.membership.createOrRenewMember(db, {
            program_id: l.membership_program_id,
            member_id: parsed.member_id,
            name: parsed.name || order.customer_name,
            email: parsed.email !== undefined ? parsed.email : order.customer_email,
          })
        );
      }
    }

    // --- mark paid + payments + audit ----------------------------------------
    const confirmation =
      order.confirmation || uniqueConfirmation(db, order.channel === 'web' ? 'W-' : 'P-');
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, confirmation = ? WHERE id = ?")
      .run(at, confirmation, orderId);

    let lastCashIdx = -1;
    pays.forEach((p, i) => { if (p.method === 'cash') lastCashIdx = i; });
    const insPay = db.prepare(
      `INSERT INTO payments (order_id, method, amount_cents, change_cents, ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    pays.forEach((p, i) =>
      insPay.run(orderId, p.method, p.amount, i === lastCashIdx ? change : 0, p.ref, at)
    );

    const detail = getOrderDetail(db, orderId);
    audit(db, order.cashier_id, 'pos.order.finalize', {
      order_id: orderId, confirmation, channel: order.channel,
      total_cents: order.total_cents, change_cents: change,
      tickets: detail.tickets.length, members: members.length,
    });
    return { order: detail, tickets: detail.tickets, members, change_cents: change };
  });
}

// Full refund: paid -> refunded, tickets void, capacity released, negative payment
// rows (net of change), refunded_at, audit. approverId attributes the manager who
// approved the refund (may equal userId when a manager runs their own session).
function refundOrder(db, ctx, orderId, userId, approverId) {
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new ApiError(404, 'not_found', `No order ${orderId}`);
    if (order.status !== 'paid') {
      throw new ApiError(409, 'not_refundable', `Only paid orders can be refunded (order is ${order.status})`);
    }
    const lines = db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(orderId);
    for (const l of lines) {
      if (l.event_session_id != null) {
        ctx.modules.events.releaseCapacity(db, l.event_session_id, l.qty);
      }
    }
    const voided = db
      .prepare(
        `UPDATE tickets SET status = 'void'
         WHERE status != 'void'
           AND order_line_id IN (SELECT id FROM order_lines WHERE order_id = ?)`
      )
      .run(orderId).changes;

    const at = now();
    const insPay = db.prepare(
      `INSERT INTO payments (order_id, method, amount_cents, change_cents, ref, created_at)
       VALUES (?, ?, ?, 0, 'REFUND', ?)`
    );
    for (const p of db
      .prepare('SELECT * FROM payments WHERE order_id = ? AND amount_cents > 0')
      .all(orderId)) {
      insPay.run(orderId, p.method, -(p.amount_cents - p.change_cents), at);
    }
    db.prepare("UPDATE orders SET status = 'refunded', refunded_at = ? WHERE id = ?")
      .run(at, orderId);
    audit(db, userId ?? null, 'pos.order.refund', {
      order_id: orderId, confirmation: order.confirmation,
      total_cents: order.total_cents, voided_tickets: voided,
      approved_by: approverId ?? null,
    });
    return { order: getOrderDetail(db, orderId), voided_tickets: voided };
  });
}

function mount(router, ctx) {
  const db = ctx.db;
  // Per-IP throttle for the approver re-auth path: unknown approver usernames
  // never lock an account but still cost a full scrypt, so without this an
  // authenticated seller could burn CPU with unbounded void/refund attempts.
  const approverRateLimit = createRateLimiter();

  // Create an open order (priced server-side). Body:
  // {lines:[{product_id, qty, event_session_id?, member?}], discount_code?, customer?}
  router.post('/api/pos/orders', SELL, (req) => {
    const order = createOrder(
      db, ctx,
      {
        lines: req.body?.lines,
        discount_code: req.body?.discount_code,
        customer: req.body?.customer,
        cashier_id: req.user.id,
      },
      'pos'
    );
    return { order };
  });

  // Search by confirmation / customer name / email (recent first).
  router.get('/api/pos/orders', SELL, (req) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const orders = db
      .prepare(
        `SELECT id, confirmation, channel, status, customer_name, customer_email,
                total_cents, created_at, paid_at, refunded_at
         FROM orders
         WHERE ? = '' OR confirmation LIKE ? OR customer_name LIKE ? OR customer_email LIKE ?
         ORDER BY id DESC LIMIT 50`
      )
      .all(q, like, like, like);
    return { orders };
  });

  router.get('/api/pos/orders/:id', SELL, (req) => {
    const order = getOrderDetail(db, Number(req.params.id));
    if (!order) throw new ApiError(404, 'not_found', `No order ${req.params.id}`);
    return { order };
  });

  router.post('/api/pos/orders/:id/finalize', SELL, (req) =>
    finalizeOrder(db, ctx, Number(req.params.id), req.body?.payments)
  );

  // Void an unpaid (open) order — any seller, with manager re-auth: the body
  // must carry approver {username, password} resolving to an active manager or
  // admin. The credential is rate-limited per IP and verified (counting toward
  // the approver's lockout) before the transaction opens; the password itself
  // is never logged.
  router.post('/api/pos/orders/:id/void', SELL, (req, res) => {
    approverRateLimit(req, res);
    const approver = verifyManagerCredential(db, req.body?.approver, req.socket?.remoteAddress);
    return tx(db, () => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
      if (!order) throw new ApiError(404, 'not_found', `No order ${req.params.id}`);
      if (order.status !== 'open') {
        throw new ApiError(409, 'not_voidable', `Only open orders can be voided (order is ${order.status})`);
      }
      db.prepare("UPDATE orders SET status = 'void' WHERE id = ?").run(order.id);
      audit(db, req.user.id, 'pos.order.void', { order_id: order.id, approved_by: approver.id });
      return { order: getOrderDetail(db, order.id) };
    });
  });

  // Full refund of a paid order — any seller, with the same manager re-auth.
  router.post('/api/pos/orders/:id/refund', SELL, (req, res) => {
    approverRateLimit(req, res);
    const approver = verifyManagerCredential(db, req.body?.approver, req.socket?.remoteAddress);
    return refundOrder(db, ctx, Number(req.params.id), req.user.id, approver.id);
  });
}

module.exports = { mount, createOrder, finalizeOrder, refundOrder };
