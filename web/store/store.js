'use strict';
// Guest storefront helper — no session, no shell.js. Cart lives in localStorage.
(function () {
  const CART_KEY = 'opstore_cart';

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.code = (data && data.error) || 'error';
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function money(cents) {
    return '$' + (Number(cents || 0) / 100).toFixed(2);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtSession(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // ---- cart ------------------------------------------------------------------
  function cartGet() {
    try {
      const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }
  function cartSave(items) {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
    renderCartCount();
  }
  // item: {product_id, name, price_cents, qty, event_session_id?, session_label?}
  function cartAdd(item) {
    const items = cartGet();
    const found = items.find(
      (i) => i.product_id === item.product_id &&
        (i.event_session_id || null) === (item.event_session_id || null)
    );
    if (found) found.qty += item.qty;
    else items.push(item);
    cartSave(items);
  }
  function cartCount() {
    return cartGet().reduce((a, i) => a + i.qty, 0);
  }
  function cartClear() {
    localStorage.removeItem(CART_KEY);
    renderCartCount();
  }

  function renderCartCount() {
    const el = document.getElementById('st-cart-count');
    if (el) el.textContent = String(cartCount());
  }

  // ---- shared chrome -----------------------------------------------------------
  function header(active) {
    const link = (href, label, key) =>
      `<a href="${href}"${active === key ? ' style="color:#fff"' : ''}>${label}</a>`;
    return `
      <header class="st-topbar st-noprint">
        <a class="brand" href="/store/">AURORA SCIENCE PARK<small>tickets</small></a>
        <nav>
          ${link('/store/', 'Tickets', 'home')}
          ${link('/store/order.html', 'Find my order', 'order')}
        </nav>
        <a class="st-cart-link" href="/store/cart.html">Cart (<span id="st-cart-count">0</span>)</a>
      </header>`;
  }

  function init(active) {
    document.body.insertAdjacentHTML('afterbegin', header(active));
    renderCartCount();
  }

  // ---- ticket / order rendering (confirmation + order lookup pages) -------------
  function renderOrder(order, mountEl) {
    const parts = [];
    parts.push(`
      <div class="st-panel st-noprint">
        <h2 style="margin:0 0 6px">Order ${esc(order.confirmation)}
          <span class="st-muted" style="font-size:14px">· ${esc(order.status)}</span></h2>
        <p class="st-muted" style="margin:0">${esc(order.customer_name)} · ${esc(order.customer_email)}</p>
        <div class="st-totals" style="margin:12px 0 0;max-width:100%">
          <div><span>Subtotal</span><span>${money(order.subtotal_cents)}</span></div>
          ${order.discount_cents ? `<div><span>Discount ${esc(order.discount_code || '')}</span><span>−${money(order.discount_cents)}</span></div>` : ''}
          <div><span>Tax</span><span>${money(order.tax_cents)}</span></div>
          <div class="grand"><span>Total paid</span><span>${money(order.total_cents)}</span></div>
        </div>
        ${order.tickets.length ? '<p class="st-muted st-noprint">Print this page — each ticket prints on its own sheet. Show the barcode at the gate.</p>' : ''}
      </div>`);

    for (const t of order.tickets) {
      parts.push(`
        <article class="st-ticket">
          <div class="venue">Owl Park · admit one</div>
          <h3>${esc(t.product_name)}</h3>
          <div class="meta">
            ${t.event_name ? `<div><strong>${esc(t.event_name)}</strong> — ${esc(fmtSession(t.session_starts_at))}</div>` : ''}
            <div>Guest: ${esc(t.holder_name || order.customer_name)}</div>
            <div>Valid ${esc(new Date(t.valid_from).toLocaleDateString())} – ${esc(new Date(t.valid_to).toLocaleDateString())}</div>
            ${t.status !== 'valid' ? `<div class="st-badge-soldout">${esc(t.status)}</div>` : ''}
          </div>
          <div class="bc" data-code="${esc(t.code)}"></div>
        </article>`);
    }

    for (const m of order.members) {
      parts.push(`
        <article class="st-ticket">
          <div class="venue">Owl Park · membership pass</div>
          <h3>${esc(m.name)}</h3>
          <div class="meta">
            <div>Member no: ${esc(m.member_no)}</div>
            <div>Valid through ${esc(new Date(m.expires_at).toLocaleDateString())}</div>
          </div>
          <div class="bc" data-code="${esc(m.pass_code)}"></div>
        </article>`);
    }

    mountEl.innerHTML = parts.join('');
    for (const el of mountEl.querySelectorAll('.bc[data-code]')) {
      window.barcode39(el, el.dataset.code);
    }
  }

  window.gs = {
    api, money, esc, fmtSession, init, renderOrder,
    cartGet, cartSave, cartAdd, cartClear, cartCount,
  };
})();
