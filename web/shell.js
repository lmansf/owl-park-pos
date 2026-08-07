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
    { href: '/backups.html', label: 'Backups', roles: ['admin'] },
    { href: '/help.html', label: 'Help', roles: ['admin', 'manager', 'cashier', 'gate'] },
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
    // same-origin relative path + search, so ?next= lands back on the exact view
    const here = () => encodeURIComponent(location.pathname + location.search);
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      location.href = '/login.html?next=' + here();
      throw new Error('unauthenticated');
    }
    if (res.status === 403 && data?.error === 'password_change_required') {
      // production mode: seeded accounts must set a real password before working
      location.href = '/login.html?pw=1&next=' + here();
      throw new Error('password_change_required');
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
    // collapse an identical still-visible message instead of stacking a twin
    const last = wrap.lastElementChild;
    if (last && last.textContent === msg && last.className === `op-toast ${kind}`) {
      clearTimeout(last._t);
      last._t = setTimeout(() => last.remove(), kind === 'err' ? 8000 : 5000);
      return;
    }
    const el = document.createElement('div');
    el.className = `op-toast ${kind}`;
    el.textContent = msg;
    el.title = 'Dismiss';
    el.onclick = () => { clearTimeout(el._t); el.remove(); };
    wrap.appendChild(el);
    // errors linger longer so they can actually be read; any toast dismisses on tap
    el._t = setTimeout(() => el.remove(), kind === 'err' ? 8000 : 5000);
  }

  // Disable a button while an async action runs — the shared double-submit guard.
  // Usage: op.busy(btn, () => op.api(...)); restores label/disabled state in finally.
  async function busy(btn, fn, pendingLabel) {
    if (!btn || btn.disabled) return undefined;
    const label = btn.textContent;
    btn.disabled = true;
    if (pendingLabel) btn.textContent = pendingLabel;
    try { return await fn(); }
    finally { btn.disabled = false; btn.textContent = label; }
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
      <div class="op-user">${esc(me.display_name)} · ${me.role}<button id="op-passwd" title="Change password">Password</button><button id="op-logout">Sign out</button></div>`;
    document.body.prepend(bar);
    fetch('/api/health').then((r) => r.json()).then((h) => {
      if (h.ephemeral) {
        const note = document.createElement('div');
        note.className = 'op-demo-banner';
        note.textContent = 'Hosted demo — the database is ephemeral and reseeds itself periodically. Changes are not saved.';
        bar.after(note);
      }
      if (h.disk_low) { // admin/manager only — anon health has no disk fields
        const warn = document.createElement('div');
        warn.className = 'op-demo-banner';
        warn.textContent = 'Low disk space on the server — back up and free space before it fills up.';
        bar.after(warn);
      }
    }).catch(() => {});
    document.getElementById('op-logout').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST', body: {} });
      location.href = '/login.html';
    };
    document.getElementById('op-passwd').onclick = () => {
      // login.html shows the change-password card directly for signed-in visitors
      location.href = '/login.html?pw=1&next=' + encodeURIComponent(location.pathname);
    };

    // role gate: if this page isn't in the user's nav, bounce to their first page
    const allowed = NAV.filter((n) => n.roles.includes(me.role)).map((n) => n.href);
    if (page && !allowed.includes(page)) location.href = allowed[0] || '/login.html';
    return me;
  }

  return { api, toast, busy, money, esc, fmtTime, fmtDate, init, get me() { return me; } };
})();
