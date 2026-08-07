'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { logError } = require('./log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// Shared request-body integer parsing: every builder module validates ints the
// same way, so the rule lives here next to ApiError instead of being copied per
// module (and drifting back to lenient).
// Strict: only real numbers or non-empty numeric strings. Number() alone coerces
// null->0, true->1, [7]->7, ''->0 — a PUT {price_cents: null} must 400, never
// silently zero a price.
function toInt(v, field, { min = null, max = null } = {}) {
  const n =
    typeof v === 'number' ? v
      : typeof v === 'string' && v.trim() !== '' ? Number(v)
        : NaN;
  const bad = (msg) => new ApiError(400, 'bad_request', msg);
  if (!Number.isInteger(n)) throw bad(`${field} must be an integer`);
  if (min !== null && n < min) throw bad(`${field} must be >= ${min}`);
  if (max !== null && n > max) throw bad(`${field} must be <= ${max}`);
  return n;
}

function compile(pattern) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$'
  );
  return { regex, keys };
}

class Router {
  constructor({ webRoot, resolveUser, guard }) {
    this.routes = [];
    this.webRoot = webRoot;
    this.resolveUser = resolveUser; // (req) => user row or null
    this.guard = guard || null; // optional (req, pathname) hook after auth; may throw ApiError
  }

  // roles: null = public; [] = any signed-in user; ['admin',...] = restricted
  add(method, pattern, roles, handler) {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, regex, keys, roles, handler });
  }

  get(p, roles, h) { this.add('GET', p, roles, h); }
  post(p, roles, h) { this.add('POST', p, roles, h); }
  put(p, roles, h) { this.add('PUT', p, roles, h); }
  del(p, roles, h) { this.add('DELETE', p, roles, h); }

  // Callers discard dispatch's promise (main.js, api/index.js), so a rejection
  // here becomes an unhandled rejection and Node kills the process. dispatch
  // must therefore never reject: it delegates to route() and turns any escape
  // into a logged 500.
  async dispatch(req, res) {
    try {
      await this.route(req, res);
    } catch (err) {
      logError('http.dispatch', err, { method: req.method, url: req.url });
      try {
        if (!res.headersSent) {
          sendJSON(res, 500, { error: 'internal', message: 'Internal error' });
        } else if (!res.writableEnded) {
          res.destroy();
        }
      } catch { /* socket already gone */ }
    }
  }

  async route(req, res) {
    let pathname;
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname); // throws URIError on e.g. /%zz
      req.query = Object.fromEntries(url.searchParams);
    } catch {
      sendJSON(res, 400, { error: 'bad_request', message: 'Malformed URL encoding' });
      return;
    }
    req.cookies = parseCookies(req.headers.cookie || '');

    if (pathname.startsWith('/api/')) {
      for (const route of this.routes) {
        if (route.method !== req.method) continue;
        const m = route.regex.exec(pathname);
        if (!m) continue;
        req.params = {};
        route.keys.forEach((k, i) => (req.params[k] = m[i + 1]));
        try {
          if (route.roles !== null) {
            req.user = this.resolveUser(req);
            if (!req.user) throw new ApiError(401, 'unauthenticated', 'Sign in required');
            if (route.roles.length && !route.roles.includes(req.user.role)) {
              throw new ApiError(403, 'forbidden', 'Your role cannot do this');
            }
            if (this.guard) this.guard(req, pathname);
          } else {
            req.user = this.resolveUser(req); // best-effort for public routes
          }
          if (req.method !== 'GET') req.body = await readJson(req);
          const result = await route.handler(req, res);
          if (!res.writableEnded) sendJSON(res, 200, result ?? { ok: true });
        } catch (err) {
          if (err instanceof ApiError) {
            sendJSON(res, err.status, { error: err.code, message: err.message });
          } else {
            logError('api.error', err, { method: req.method, path: pathname });
            sendJSON(res, 500, { error: 'internal', message: 'Internal error' });
          }
        }
        return;
      }
      sendJSON(res, 404, { error: 'not_found', message: `No route ${req.method} ${pathname}` });
      return;
    }

    this.serveStatic(pathname, res);
  }

  serveStatic(pathname, res) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(this.webRoot, rel));
    // Containment needs the trailing separator: a bare prefix test lets
    // /%2e%2e%2fweb.bak escape to any SIBLING of webRoot whose name merely
    // starts with the webRoot string. NUL bytes would make fs.readFile throw.
    if (rel.includes('\0') || !file.startsWith(this.webRoot + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        if (!path.extname(file)) {
          // extensionless → try .html
          fs.readFile(file + '.html', (err2, data2) => {
            if (err2) return res.writeHead(404).end('not found');
            res.writeHead(200, { 'content-type': MIME['.html'] }).end(data2);
          });
          return;
        }
        res.writeHead(404).end('not found');
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(data);
    });
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // one malformed %-escape in a stale cookie must not fail the request
        // (or, pre-fix, the process): treat that cookie as absent → fail closed
      }
    }
  }
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) reject(new ApiError(413, 'too_large', 'Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, 'bad_json', 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' }).end(body);
}

function sendCSV(res, filename, rows) {
  // Cells a spreadsheet would evaluate (leading = + - @ tab CR) are neutralised
  // with a leading apostrophe per OWASP CSV-injection guidance — free-text like
  // drawer reasons and gate names is attacker-writable and lands in exports a
  // manager opens in Excel. Plain numbers (e.g. -12.50) stay untouched.
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number' && !/^-?\d+(\.\d+)?$/.test(s)) {
      s = "'" + s;
    }
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
  }).end(body);
}

module.exports = { Router, ApiError, sendJSON, sendCSV, toInt };
