'use strict';
// The POS receipt renderer, exercised against the payload shapes the server
// actually hands it. web/pos.html is a single inline-script page with no build
// step and no DOM harness in this repo, so renderReceipt is lifted out of the
// page source and run with stub helpers that behave exactly like the real ones
// (op.money is web/shell.js's, character for character).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'web', 'pos.html');

function loadRenderReceipt() {
  const src = fs.readFileSync(PAGE, 'utf8');
  const start = src.indexOf('  function renderReceipt(');
  const end = src.indexOf('  // ---------- order search ----------');
  assert.ok(start > 0 && end > start, 'renderReceipt block located in web/pos.html');

  const html = {};
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        set innerHTML(v) { html[id] = v; },
        get innerHTML() { return html[id] || ''; },
        querySelectorAll: () => [],
        onclick: null,
      });
    }
    return nodes.get(id);
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (cents) =>
    (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const op = {
    fmtDate: (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
    fmtTime: (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
  const tenderLabel = (m) => ({ cash: 'Cash', card_sim: 'Card', voucher: 'Voucher' }[m] || m);

  const factory = new Function(
    'esc', 'money', 'op', 'tenderLabel', 'barcode39Svg', '$', 'statusBadge', 'receiptFrom',
    `${src.slice(start, end)}\n return renderReceipt;`
  );
  const renderReceipt = factory(
    esc, money, op, tenderLabel, () => '<svg></svg>', node, (s) => s, 'orders'
  );
  return (order, opts) => { renderReceipt(order, opts); return html.receipt; };
}

const baseOrder = (payments) => ({
  id: 7, confirmation: 'P-ABC123456', channel: 'pos', status: 'paid',
  created_at: new Date().toISOString(), paid_at: new Date().toISOString(),
  customer_name: '', customer_email: '',
  subtotal_cents: 2995, discount_cents: 0, discount_code: null, tax_cents: 187,
  total_cents: 3182,
  lines: [{ qty: 1, description: 'Adult Admission', unit_price_cents: 2995, discount_cents: 0, refunded_qty: 0 }],
  payments,
  tickets: [],
});

test('pos receipt: a withheld tender is never printed as $0.00', () => {
  const render = loadRenderReceipt();
  // exactly what GET /api/pos/orders/:id returns to the cashier whose own drawer
  // is still open (blind close), for a $31.82 sale tendered $50 cash
  const out = render(
    { ...baseOrder([{ method: 'withheld', amount_cents: null, change_cents: null, ref: null, withheld: true }]), payments_withheld: true },
    {}
  );
  assert.ok(!out.includes('$0.00'), 'no fabricated amount on the guest copy');
  assert.ok(!/>\s*withheld/.test(out), 'the raw "withheld" method never reaches paper');
  assert.match(out, /hidden until drawer close/);
  assert.match(out, /reprint after the drawer is closed/);
  assert.ok(out.includes('$31.82'), 'the TOTAL still prints');
});

test('pos receipt: a refund receipt always states the refunded amount', () => {
  const render = loadRenderReceipt();
  const order = baseOrder([
    { method: 'withheld', amount_cents: null, change_cents: null, ref: null, withheld: true },
    { method: 'withheld', amount_cents: null, change_cents: null, ref: null, withheld: true, refund: true },
  ]);
  order.status = 'refunded';
  const out = render(order, { refund_cents: 3182 });
  assert.match(out, /Refunded this transaction/);
  assert.ok(out.includes('−$31.82'), 'the refunded amount appears on the customer copy');
  assert.match(out, /REFUND Tender/, 'a negative row is never printed as a payment');
  assert.ok(!out.includes('$0.00'));
});

test('pos receipt: readable payments still print in full, change included', () => {
  const render = loadRenderReceipt();
  const out = render(
    baseOrder([{ method: 'cash', amount_cents: 5000, change_cents: 1818, ref: null }]),
    {}
  );
  assert.ok(out.includes('Cash'));
  assert.ok(out.includes('$50.00'));
  assert.match(out, /Change/);
  assert.ok(out.includes('$18.18'));
  assert.ok(!out.includes('hidden until drawer close'));
});

test('pos: the tender dialog never leaks the order it opened', () => {
  const src = fs.readFileSync(PAGE, 'utf8');
  // cancel, Esc and every error path close the dialog; that is the one place the
  // abandon call has to hang off, and finalize must clear the order before closing
  assert.match(src, /dlgTender\.addEventListener\('close', \(\) => \{ dropCurrentOrder\(\); \}\)/);
  assert.match(src, /async function dropCurrentOrder\(\)/);
  assert.match(src, /\/abandon`, \{ body: \{\} \}\)/);
  const finalize = src.slice(src.indexOf("$('tender-finalize').onclick"));
  assert.ok(
    finalize.indexOf('currentOrder = null;') < finalize.indexOf('dlgTender.close();'),
    'a finalized order is cleared before the dialog closes, so it is never abandoned'
  );
});
