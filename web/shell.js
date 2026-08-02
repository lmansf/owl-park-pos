'use strict';
// Shared back-office chrome. Include AFTER a <body> exists; call op.init({page}) per page.
window.op = (() => {
  const NAV = [
    { href: '/index.html', label: 'Dashboard', roles: ['admin', 'manager', 'cashier'] },
    { href: '/pos.html', label: 'POS', roles: ['admin', 'manager', 'cashier'] },
    { href: '/admissions.html', label: 'Admissions', roles: ['admin', 'manager', 'cashier', 'gate'] },
    { href: '/catalog.html', label: 'Catalog', roles: ['admin', 'manager'] },
    { href: '/events.html', label: 'Events', roles: ['admin', 'manager'] },
    { href: '/members.html', label: 'Members', roles: ['admin', 'manager', 'cashier'] },
    { href: '/item-groups.html', label: 'Groups', roles: ['admin', 'manager'] },
    { href: '/menu-builder.html', label: 'Menus', roles: ['admin', 'manager'] },
    { href: '/store-builder.html', label: 'Store Builder', roles: ['admin', 'manager'] },
    { href: '/discounts.html', label: 'Discounts', roles: ['admin', 'manager'] },
    { href: '/price-programs.html', label: 'Pricing', roles: ['admin', 'manager'] },
    { href: '/accounts.html', label: 'Accounts', roles: ['admin', 'manager'] },
    { href: '/reports.html', label: 'Reports', roles: ['admin', 'manager'] },
  ];

  let me = null;

  async function api(path, opts = {}) {
    const init = { headers: {}, ...opts };
    if (init.body !== undefined && typeof init.body !== 'string') {
      init.body = JSON.stringify(init.body);
      init.headers['content-type'] = 'application/json';
      init.method = init.method || 'POST';
    }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON (e.g. CSV) */ }
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname);
      throw new Error('unauthenticated');
    }
    if (!res.ok) {
      const msg = data?.message || `Request failed (${res.status})`;
      toast(msg, 'err');
      const err = new Error(msg);
      err.code = data?.error;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg, kind = '') {
    let wrap = document.querySelector('.op-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'op-toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = `op-toast ${kind}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function money(cents) {
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function init({ page } = {}) {
    try {
      me = (await api('/api/auth/me')).user;
    } catch { return null; }

    const bar = document.createElement('header');
    bar.className = 'op-topbar';
    const links = NAV.filter((n) => n.roles.includes(me.role))
      .map((n) => `<a href="${n.href}" class="${n.href === page ? 'active' : ''}">${n.label}</a>`)
      .join('');
    bar.innerHTML = `
      <div class="op-brand">OWL PARK<small>point of sale</small></div>
      <nav class="op-nav">${links}</nav>
      <div class="op-user">${esc(me.display_name)} · ${me.role}<button id="op-logout">Sign out</button></div>`;
    document.body.prepend(bar);
    document.getElementById('op-logout').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST', body: {} });
      location.href = '/login.html';
    };

    // role gate: if this page isn't in the user's nav, bounce to their first page
    const allowed = NAV.filter((n) => n.roles.includes(me.role)).map((n) => n.href);
    if (page && !allowed.includes(page)) location.href = allowed[0] || '/login.html';
    return me;
  }

  return { api, toast, money, esc, fmtTime, fmtDate, init, get me() { return me; } };
})();
