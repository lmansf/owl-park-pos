'use strict';
// pos — order creation + pricing, THE shared posting path (finalizeOrder),
// void/refund (full or per-line) and session exchanges.
// finalizeOrder is the ONLY code path that marks orders paid — the online store
// must call it too. Ticket rows are created only through issueTicket, and
// event_sessions.sold moves only through events.reserveCapacity/releaseCapacity
// (finalize, refund and exchange all inside one tx each).
const { ApiError } = require('../core/http');
const { tx, now } = require('../core/db');
const { audit, randomCode, verifyManagerCredential, createRateLimiter } = require('../core/auth');

const SELL = ['cashier', 'manager', 'admin'];
const DAY_MS = (24 * 3600 * 1000);
const REF_MAX = 64; // refs land in DB rows and receipts — cap attacker-length input
const MAX_REFUND_LINES = 200; // sanity cap on a refund selection body

// Tender registry — adding a tender = adding an entry here (plus, optionally, a
// default clearing mapping in accounts.js). finalizeOrder consumes the registry;
// its invariants (single tx, only path to paid/tickets/capacity) are untouched.
// `change: true` marks tenders that can hand change back (cash-like); only those
// rows may ever carry a non-zero change_cents. `authorize` is a pure, simulated
// hook (zero network at runtime): it receives (amount_cents, {ref}) and returns
// the ref to store — the seam a real processor integration would fill.
const TENDERS = [
  { method: 'cash', label: 'Cash', change: true,
    authorize: (amount, meta) => ({ ref: meta.ref }) },
  { method: 'card_sim', label: 'Card', change: false,
    authorize: (amount, meta) => ({ ref: meta.ref || 'AUTH-' + randomCode('', 6) }) },
  { method: 'voucher', label: 'Voucher', change: false,
    authorize: (amount, meta) => ({ ref: meta.ref || 'VOUCHER' }) },
];
const TENDER_BY_METHOD = new Map(TENDERS.map((t) => [t.method, t]));

// Public view only — never expose the authorize hooks.
function listTenders() {
  return TENDERS.map(({ method, label, change }) => ({ method, label, change }));
}

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

// THE ticket issuance chokepoint inside this module: finalizeOrder and the
// exchange path both create ticket rows only through here.
function issueTicket(db, t) {
  const info = db
    .prepare(
      `INSERT INTO tickets (code, order_line_id, product_id, event_session_id, status,
         uses_remaining, valid_from, valid_to, holder_name, exchanged_from)
       VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?)`
    )
    .run(
      uniqueTicketCode(db), t.order_line_id, t.product_id, t.event_session_id,
      t.uses_remaining, t.valid_from, t.valid_to, t.holder_name || '',
      t.exchanged_from ?? null
    );
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(info.lastInsertRowid));
}

function uniqueConfirmation(db, prefix) {
  for (let i = 0; i < 25; i++) {
    const code = prefix + randomCode('', 9);
    if (!db.prepare('SELECT 1 FROM orders WHERE confirmation = ?').get(code)) return code;
  }
  throw new Error('could not allocate unique confirmation');
}

// Explicit member info for membership lines lives in structured columns:
// order_lines.member_id (renewal target; stamped at finalize once posted) and
// order_lines.member_intent (server-written JSON {"name","email"} for a new member).
// memberSuffix only decorates the human-readable description —
//   "Explorer Annual Membership (renewal #12)"
//   "Explorer Annual Membership (for Pat Smith <pat@example.com>)"
// — display text that is never parsed back.
function memberSuffix(member) {
  if (!member) return '';
  if (member.member_id) return ` (renewal #${Number(member.member_id)})`;
  const name = String(member.name || '').replace(/[<>()]/g, '').trim();
  const email = String(member.email || '').replace(/[<>()]/g, '').trim();
  if (!name && !email) return '';
  return ` (for ${name}${email ? ` <${email}>` : ''})`;
}

// member_intent column -> {name, email} or null. Backfilled/legacy rows could hold
// junk; a parse failure means "no intent" (falls back to the order email, as ever).
function memberIntent(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') {
      return { name: String(v.name ?? ''), email: String(v.email ?? '') };
    }
  } catch { /* ignore */ }
  return null;
}

// Full order view: order row + lines + payments + tickets.
function getOrderDetail(db, id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  order.lines = db
    .prepare(
      `SELECT ol.*, p.kind AS product_kind, p.sku, p.event_id,
              s.starts_at AS session_starts_at
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
      `SELECT t.*, ol.description AS line_description, p.event_id,
              s.starts_at AS session_starts_at, s.ends_at AS session_ends_at
       FROM tickets t
       JOIN order_lines ol ON ol.id = t.order_line_id
       JOIN products p ON p.id = t.product_id
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
        const target = Number.isInteger(mid) && mid > 0
          ? db.prepare('SELECT email FROM members WHERE id = ?').get(mid)
          : null;
        // Web checkout is anonymous: only allow renewing a member whose email matches
        // the buyer's. Same error either way so member ids cannot be enumerated.
        const buyerEmail = String(payload?.customer?.email || '').trim().toLowerCase();
        if (
          !target ||
          (channel === 'web' && String(target.email).toLowerCase() !== buyerEmail)
        ) {
          throw bad('bad_member', `No member ${raw.member.member_id}`);
        }
        member = { member_id: mid };
      } else {
        const name = String(raw.member.name ?? '').trim().slice(0, 200);
        const email = String(raw.member.email ?? '').trim().slice(0, 200);
        member = name || email ? { name, email } : null;
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
         discount_cents, tax_cents, line_total_cents, event_session_id, member_id,
         member_intent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      const desc =
        l.product.name + (l.product.kind === 'membership' ? memberSuffix(l.member) : '');
      ins.run(
        orderId, l.product.id, desc, l.qty, l.product.price_cents,
        l.discount, l.tax, l.total, l.sessionId,
        l.member?.member_id ?? null,
        l.member && !l.member.member_id
          ? JSON.stringify({ name: l.member.name, email: l.member.email })
          : null
      );
    }
    return getOrderDetail(db, orderId);
  });
}

// The shared posting path. payments = [{method:<registry key>, amount_cents, ref?}].
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
    let changeableSum = 0; // total tendered in change-bearing tenders (cash-like)
    const pays = rawPays.map((p) => {
      // Exact registry lookup (Map keyed by string) — whitelists method before
      // it ever reaches SQL; no prefix/case-insensitive matching.
      const tender = TENDER_BY_METHOD.get(p?.method);
      if (!tender) {
        throw bad(
          'bad_method',
          `Payment method must be one of ${TENDERS.map((t) => t.method).join(', ')}`
        );
      }
      const amount = Number(p?.amount_cents);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw bad('bad_amount', 'amount_cents must be a positive integer');
      }
      sum += amount;
      if (tender.change) changeableSum += amount;
      const { ref } = tender.authorize(amount, {
        ref: String(p?.ref || '').trim().slice(0, REF_MAX),
      });
      return { method: tender.method, change: tender.change, amount, ref };
    });
    if (sum < order.total_cents) {
      throw bad(
        'insufficient_tender',
        `Tendered ${sum} of ${order.total_cents} cents — cannot finalize`
      );
    }
    const change = sum - order.total_cents;
    if (change > changeableSum) {
      throw bad(
        'bad_tender',
        'Change cannot exceed the amount tendered in change-bearing tenders — reduce the non-change tender amounts'
      );
    }

    // --- drawer attribution (POS channel only): cash needs the cashier's open
    // drawer; the session is re-resolved INSIDE this tx so a concurrently
    // closed drawer can never be stamped. Web-channel payments stay NULL.
    let drawerSessionId = null;
    if (order.channel === 'pos') {
      // actual cash only (drawer.isCashMethod), not every change-bearing tender
      const cashSum = pays.reduce(
        (a, p) => a + (ctx.modules.drawer.isCashMethod(p.method) ? p.amount : 0), 0);
      const drawer = ctx.modules.drawer.openSessionFor(db, order.cashier_id);
      if (drawer) drawerSessionId = drawer.id;
      else if (cashSum > 0) {
        throw new ApiError(409, 'no_open_drawer', 'Open a cash drawer before taking cash');
      }
    }

    const at = now();

    // --- capacity: reserve per session line (throws 409 'capacity' -> full rollback)
    for (const l of lines) {
      if (l.event_session_id != null) {
        ctx.modules.events.reserveCapacity(db, l.event_session_id, l.qty);
      }
    }

    // --- tickets: one per qty on kind='ticket' lines -------------------------
    for (const l of lines) {
      if (l.kind !== 'ticket') continue;
      const validTo = new Date(Date.parse(at) + l.validity_days * DAY_MS).toISOString();
      for (let i = 0; i < l.qty; i++) {
        issueTicket(db, {
          order_line_id: l.id, product_id: l.product_id,
          event_session_id: l.event_session_id, uses_remaining: l.max_uses,
          valid_from: at, valid_to: validTo, holder_name: order.customer_name || '',
        });
      }
    }

    // --- memberships: create or renew via the membership module --------------
    // Structured columns only; the line description is display text, never parsed.
    const members = [];
    const stampMember = db.prepare('UPDATE order_lines SET member_id = ? WHERE id = ?');
    for (const l of lines) {
      if (l.kind !== 'membership') continue;
      const intent = memberIntent(l.member_intent);
      let member = null;
      for (let i = 0; i < l.qty; i++) {
        member = ctx.modules.membership.createOrRenewMember(db, {
          program_id: l.membership_program_id,
          member_id: l.member_id || undefined,
          name: (intent && intent.name) || order.customer_name,
          email: intent ? intent.email : order.customer_email,
        });
        members.push(member);
      }
      // stamp the posted member so the line stays joinable (reports, guest view)
      if (member && member.id !== l.member_id) stampMember.run(member.id, l.id);
    }

    // --- mark paid + payments + audit ----------------------------------------
    const confirmation =
      order.confirmation || uniqueConfirmation(db, order.channel === 'web' ? 'W-' : 'P-');
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, confirmation = ? WHERE id = ?")
      .run(at, confirmation, orderId);

    // Change is attributed to the LAST change-bearing payment row so
    // SUM(amount_cents - change_cents) per order equals total_cents.
    let lastChangeIdx = -1;
    pays.forEach((p, i) => { if (p.change) lastChangeIdx = i; });
    const insPay = db.prepare(
      `INSERT INTO payments (order_id, method, amount_cents, change_cents, ref, created_at,
         drawer_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    pays.forEach((p, i) =>
      insPay.run(orderId, p.method, p.amount, i === lastChangeIdx ? change : 0, p.ref, at,
        drawerSessionId)
    );

    const detail = getOrderDetail(db, orderId);
    audit(db, order.cashier_id, 'pos.order.finalize', {
      order_id: orderId, confirmation, channel: order.channel,
      total_cents: order.total_cents, change_cents: change,
      tickets: detail.tickets.length, members: members.length,
      ...(drawerSessionId != null ? { drawer_session_id: drawerSessionId } : {}),
    });
    return { order: detail, tickets: detail.tickets, members, change_cents: change };
  });
}

// Refund a paid (or partially refunded) order, in full or per line/quantity.
// selection = [{order_line_id, qty}] refunds exactly those quantities, drawing
// from tickets a session cancellation voided first, then valid tickets; used or
// exchanged-away tickets are refused. An absent/empty selection is a full refund
// of everything still live (legacy behavior: voids remaining tickets even if
// already used — a manager decision).
// Every refund: affected tickets void, their sessions' sold released, one
// refunds header + refund_lines rows, negative payment rows allocated across
// the original tender methods, order status derived from per-line progress
// (partial_refund while some quantities remain live, refunded + refunded_at
// when nothing does), audit. approverId attributes the manager who approved
// (may equal userId when a manager runs their own session).
function refundOrder(db, ctx, orderId, userId, approverId, selection) {
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new ApiError(404, 'not_found', `No order ${orderId}`);
    if (order.status !== 'paid' && order.status !== 'partial_refund') {
      throw new ApiError(
        409, 'not_refundable',
        `Only paid or partially refunded orders can be refunded (order is ${order.status})`
      );
    }
    const lines = db
      .prepare(
        `SELECT ol.*, p.kind FROM order_lines ol
         JOIN products p ON p.id = ol.product_id
         WHERE ol.order_id = ? ORDER BY ol.id`
      )
      .all(orderId);
    const byLineId = new Map(lines.map((l) => [l.id, l]));

    // --- normalize + validate the selection (state re-read inside this tx) ---
    const explicit = Array.isArray(selection) && selection.length > 0;
    let picks; // [{line, q}]
    if (!explicit) {
      if (selection !== undefined && selection !== null && !Array.isArray(selection)) {
        throw bad('bad_lines', 'lines must be an array of {order_line_id, qty}');
      }
      picks = lines
        .filter((l) => l.refunded_qty < l.qty)
        .map((l) => ({ line: l, q: l.qty - l.refunded_qty }));
      if (!picks.length) {
        throw new ApiError(409, 'not_refundable', 'Nothing left to refund on this order');
      }
    } else {
      if (selection.length > MAX_REFUND_LINES) {
        throw bad('bad_lines', `At most ${MAX_REFUND_LINES} line entries per refund`);
      }
      const seen = new Set();
      picks = selection.map((raw) => {
        // no coercion on the money path: "2" is rejected, only real integers pass
        const lineId = raw?.order_line_id;
        if (!Number.isInteger(lineId) || !byLineId.has(lineId)) {
          throw bad('bad_line', `Order line ${raw?.order_line_id} is not part of this order`);
        }
        if (seen.has(lineId)) {
          throw bad('bad_line', `Order line ${lineId} appears more than once`);
        }
        seen.add(lineId);
        const line = byLineId.get(lineId);
        const q = raw?.qty;
        const remaining = line.qty - line.refunded_qty;
        if (!Number.isInteger(q) || q < 1 || q > remaining) {
          throw bad(
            'bad_qty',
            `Line ${lineId}: qty must be an integer between 1 and ${remaining} (unrefunded remainder)`
          );
        }
        return { line, q };
      });
    }

    const at = now();

    // Refunds never REQUIRE a drawer; if the acting user has one open, the
    // negative rows are attributed to it (cash refunds then net out of that
    // drawer's expected). Otherwise NULL — visible on the unattributed line
    // of the drawers report, never silent.
    const refundDrawer = ctx.modules.drawer.openSessionFor(db, userId ?? null);

    // --- per-line money: proportional over the unrefunded remainder, so the
    // last refund of a line always takes the exact leftover cents -------------
    const priorSums = db.prepare(
      `SELECT COALESCE(SUM(discount_cents), 0) AS disc, COALESCE(SUM(tax_cents), 0) AS tax
       FROM refund_lines WHERE order_line_id = ?`
    );
    let refundTotal = 0;
    for (const p of picks) {
      const { line, q } = p;
      const remaining = line.qty - line.refunded_qty;
      const prior = priorSums.get(line.id);
      const remDisc = line.discount_cents - prior.disc;
      const remTax = line.tax_cents - prior.tax;
      p.gross = q * line.unit_price_cents;
      p.discount = q === remaining ? remDisc : Math.round((remDisc * q) / remaining);
      p.tax = q === remaining ? remTax : Math.round((remTax * q) / remaining);
      p.total = p.gross - p.discount + p.tax;
      refundTotal += p.total;
    }

    // --- tickets + capacity: void the affected tickets, release the sessions
    // the voided tickets actually occupy (an exchanged ticket may sit in a
    // different session than its order line) ---------------------------------
    let voided = 0;
    for (const p of picks) {
      const { line, q } = p;
      let voidedTickets = [];
      if (line.kind === 'ticket') {
        if (explicit) {
          const valid = db
            .prepare("SELECT * FROM tickets WHERE order_line_id = ? AND status = 'valid' ORDER BY id")
            .all(line.id);
          // unclaimed void tickets = cancel-voided value nobody has refunded yet:
          // every refunded unit accounts for exactly one non-superseded void row
          // (it flipped one or claimed one), and exchanged-away tickets are
          // superseded by their replacement so they never count
          const voidRows = db
            .prepare(
              `SELECT COUNT(*) AS n FROM tickets t
               WHERE t.order_line_id = ? AND t.status = 'void'
                 AND NOT EXISTS (SELECT 1 FROM tickets r WHERE r.exchanged_from = t.id)`
            )
            .get(line.id).n;
          const claimable = Math.max(0, voidRows - line.refunded_qty);
          if (claimable + valid.length < q) {
            throw new ApiError(
              409, 'tickets_used',
              `Line ${line.id}: only ${claimable + valid.length} refundable ticket(s) left — used or exchanged tickets cannot be refunded`
            );
          }
          // claim cancel-voided value first (no ticket flips, no capacity move),
          // then flip valid tickets for the rest
          voidedTickets = valid.slice(0, Math.max(0, q - claimable));
        } else {
          // legacy full-refund sweep: void everything not already void
          voidedTickets = db
            .prepare("SELECT * FROM tickets WHERE order_line_id = ? AND status != 'void'")
            .all(line.id);
        }
        for (const tk of voidedTickets) {
          db.prepare("UPDATE tickets SET status = 'void' WHERE id = ?").run(tk.id);
          voided++;
          if (tk.event_session_id != null) {
            ctx.modules.events.releaseCapacity(db, tk.event_session_id, 1);
          }
        }
      } else if (line.event_session_id != null) {
        // session-bound non-ticket line: capacity follows the line itself
        ctx.modules.events.releaseCapacity(db, line.event_session_id, q);
      }
    }

    // --- refund event + per-line progress ------------------------------------
    const refundId = Number(
      db.prepare(
        'INSERT INTO refunds (order_id, user_id, total_cents, created_at) VALUES (?, ?, ?, ?)'
      ).run(orderId, userId ?? null, refundTotal, at).lastInsertRowid
    );
    const insRl = db.prepare(
      `INSERT INTO refund_lines (refund_id, order_line_id, qty, gross_cents,
         discount_cents, tax_cents, total_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const bumpLine = db.prepare(
      'UPDATE order_lines SET refunded_qty = refunded_qty + ? WHERE id = ?'
    );
    for (const p of picks) {
      insRl.run(refundId, p.line.id, p.q, p.gross, p.discount, p.tax, p.total);
      bumpLine.run(p.q, p.line.id);
    }

    // --- negative payments: allocate across the original methods, capped by
    // what each method has left (net of change and of earlier refunds) --------
    const methods = db
      .prepare(
        `SELECT method,
                SUM(CASE WHEN amount_cents > 0 THEN amount_cents - change_cents ELSE 0 END)
                + SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS remaining
         FROM payments WHERE order_id = ? GROUP BY method ORDER BY method`
      )
      .all(orderId)
      .filter((m) => m.remaining > 0);
    let remTotal = methods.reduce((a, m) => a + m.remaining, 0);
    if (refundTotal > remTotal) {
      // structurally impossible (payments net always equals the live order
      // total), but never print money if the books are inconsistent
      throw new ApiError(409, 'refund_exceeds_payments', 'Refund exceeds remaining payments');
    }
    const insPay = db.prepare(
      `INSERT INTO payments (order_id, method, amount_cents, change_cents, ref, created_at,
         drawer_session_id)
       VALUES (?, ?, ?, 0, 'REFUND', ?, ?)`
    );
    let remRefund = refundTotal;
    for (const m of methods) {
      const alloc = remTotal > 0 ? Math.round((remRefund * m.remaining) / remTotal) : 0;
      remRefund -= alloc;
      remTotal -= m.remaining;
      if (alloc > 0) {
        insPay.run(orderId, m.method, -alloc, at, refundDrawer ? refundDrawer.id : null);
      }
    }

    // --- derived order status ------------------------------------------------
    const leftLive = db
      .prepare('SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ? AND refunded_qty < qty')
      .get(orderId).n;
    if (leftLive === 0) {
      db.prepare("UPDATE orders SET status = 'refunded', refunded_at = ? WHERE id = ?")
        .run(at, orderId);
    } else {
      db.prepare("UPDATE orders SET status = 'partial_refund' WHERE id = ?").run(orderId);
    }

    audit(db, userId ?? null, 'pos.order.refund', {
      order_id: orderId, confirmation: order.confirmation,
      refund_cents: refundTotal, full: !explicit,
      lines: picks.map((p) => ({ order_line_id: p.line.id, qty: p.q })),
      voided_tickets: voided, approved_by: approverId ?? null,
    });
    return {
      order: getOrderDetail(db, orderId),
      voided_tickets: voided,
      refund: { id: refundId, total_cents: refundTotal },
    };
  });
}

// Exchange a valid timed-entry ticket to another session of the same event.
// One tx: reserve the target FIRST (a 'capacity' throw rolls everything back
// leaving the original ticket untouched), then void the original, release its
// session, and reissue through the shared issueTicket chokepoint with an
// exchanged_from link. No money moves. The replacement keeps the original's
// remaining uses; its validity window is widened just enough to cover the
// target session so an exchange can never produce an instantly-expired ticket.
function exchangeTicket(db, ctx, ticketId, targetSessionId, userId, approverId) {
  return tx(db, () => {
    const ticket = db
      .prepare(
        `SELECT t.*, p.event_id, p.name AS product_name
         FROM tickets t JOIN products p ON p.id = t.product_id WHERE t.id = ?`
      )
      .get(ticketId);
    if (!ticket) throw new ApiError(404, 'not_found', `No ticket ${ticketId}`);
    if (ticket.status !== 'valid') {
      throw new ApiError(
        409, 'not_exchangeable', `Only valid tickets can be exchanged (ticket is ${ticket.status})`
      );
    }
    if (ticket.event_session_id == null || ticket.event_id == null) {
      throw bad('not_timed', 'Only timed-entry session tickets can be exchanged');
    }
    const targetId = targetSessionId;
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw bad('bad_session', 'event_session_id must be a positive integer');
    }
    if (targetId === ticket.event_session_id) {
      throw bad('same_session', 'Ticket is already on that session');
    }
    const target = ctx.modules.events.getSession(db, targetId);
    if (!target || target.cancelled || target.event_id !== ticket.event_id) {
      throw bad('bad_session', `Session ${targetId} is not valid for ${ticket.product_name}`);
    }

    // reserve first: on a full session this throws 409 'capacity' and the
    // original ticket stays exactly as it was
    ctx.modules.events.reserveCapacity(db, targetId, 1);
    const flipped = db
      .prepare("UPDATE tickets SET status = 'void' WHERE id = ? AND status = 'valid'")
      .run(ticket.id).changes;
    if (flipped !== 1) {
      throw new ApiError(409, 'not_exchangeable', 'Ticket changed state — retry');
    }
    ctx.modules.events.releaseCapacity(db, ticket.event_session_id, 1);

    const validTo =
      Date.parse(target.ends_at) > Date.parse(ticket.valid_to) ? target.ends_at : ticket.valid_to;
    const fresh = issueTicket(db, {
      order_line_id: ticket.order_line_id, product_id: ticket.product_id,
      event_session_id: targetId, uses_remaining: ticket.uses_remaining,
      valid_from: ticket.valid_from, valid_to: validTo,
      holder_name: ticket.holder_name, exchanged_from: ticket.id,
    });

    audit(db, userId ?? null, 'pos.ticket.exchange', {
      ticket_id: ticket.id, new_ticket_id: fresh.id,
      from_session: ticket.event_session_id, to_session: targetId,
      approved_by: approverId ?? null,
      ...(refundDrawer ? { drawer_session_id: refundDrawer.id } : {}),
    });
    return {
      old_ticket: db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id),
      ticket: fresh,
    };
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

  // Tender registry for the POS tender dialog. SELL only (never public, never
  // gate): it reveals back-office tender config the gate role has no use for.
  router.get('/api/pos/tenders', SELL, () => ({ tenders: listTenders() }));

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

  // Refund a paid/partially-refunded order — any seller, with the same manager
  // re-auth. Body {lines: [{order_line_id, qty}]} refunds a selection; an
  // absent/empty lines array refunds everything still live.
  router.post('/api/pos/orders/:id/refund', SELL, (req, res) => {
    approverRateLimit(req, res);
    const approver = verifyManagerCredential(db, req.body?.approver, req.socket?.remoteAddress);
    return refundOrder(db, ctx, Number(req.params.id), req.user.id, approver.id, req.body?.lines);
  });

  // Exchange a valid timed-entry ticket to another session of the same event —
  // any seller, with the same manager re-auth as refunds (exchanges void and
  // reissue tickets, so they carry the same trust level).
  router.post('/api/pos/tickets/:id/exchange', SELL, (req, res) => {
    approverRateLimit(req, res);
    const approver = verifyManagerCredential(db, req.body?.approver, req.socket?.remoteAddress);
    return exchangeTicket(
      db, ctx, Number(req.params.id), req.body?.event_session_id, req.user.id, approver.id
    );
  });
}

module.exports = { mount, createOrder, finalizeOrder, refundOrder, listTenders, exchangeTicket };
