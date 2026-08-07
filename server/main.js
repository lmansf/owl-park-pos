'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, migrate } = require('./core/db');
const { Router, ApiError } = require('./core/http');
const auth = require('./core/auth');
const { seed } = require('./core/seed');
const { log } = require('./core/log');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.OWLPOS_PORT || 4650);
const DB_PATH = process.env.OWLPOS_DB || path.join(ROOT, 'data', 'owlpark-pos.db');

// While a production-mode user must change their password, only these routes work.
const PW_CHANGE_ALLOWED = new Set([
  '/api/auth/change-password', '/api/auth/logout', '/api/auth/me',
]);

const DISK_LOW_BYTES = 500 * 1024 * 1024; // warn admins below 500 MB free

function createApp(dbPath = DB_PATH, opts = {}) {
  const env = opts.env || process.env;
  // Fail-closed: in production mode this throws (no OWLPOS_SECRET, too short)
  // before anything listens. Demo mode keeps the per-process random fallback.
  const config = auth.resolveConfig(env);
  const db = openDb(dbPath);
  migrate(db, path.join(__dirname, 'migrations'));
  if (seed(db)) log('info', 'seed.created');

  const router = new Router({
    webRoot: path.join(ROOT, 'web'),
    resolveUser: auth.resolveUser(db, config),
    guard: (req, pathname) => {
      if (config.mode !== 'production') return; // demo keeps today's behavior exactly
      if (req.user?.must_change_password && !PW_CHANGE_ALLOWED.has(pathname)) {
        throw new ApiError(403, 'password_change_required', 'Set a new password to continue');
      }
    },
  });
  auth.mount(router, db, config);

  const ctx = {
    db,
    dbPath,
    backupDir: env.OWLPOS_BACKUP_DIR || path.join(path.dirname(dbPath), 'backups'),
    env,
    modules: {},
  };

  // Deployment self-description: hosted demos (Vercel) run with an ephemeral
  // /tmp database that reseeds on cold start; the UI shows a banner when so.
  // mode lets the login page hide the demo-credentials hint in production.
  // Anonymous callers get exactly { ok, ephemeral, mode }; disk/backup fields
  // would leak host layout, so they are appended only for admin/manager sessions
  // (req.user is resolved best-effort even on public routes).
  router.get('/api/health', null, (req) => {
    const out = { ok: true, ephemeral: Boolean(env.VERCEL), mode: config.mode };
    if (req.user && ['admin', 'manager'].includes(req.user.role)) {
      const st = fs.statfsSync(path.dirname(dbPath));
      out.disk_free_bytes = st.bavail * st.bsize;
      out.db_bytes = fs.statSync(dbPath).size;
      out.disk_low = out.disk_free_bytes < DISK_LOW_BYTES;
      out.last_backup_at = ctx.modules.backups?.lastBackupAt?.(ctx) ?? null;
    }
    return out;
  });

  // Auto-mount every module in server/modules/ (each exports mount(router, ctx))
  const modulesDir = path.join(__dirname, 'modules');
  if (fs.existsSync(modulesDir)) {
    for (const file of fs.readdirSync(modulesDir).filter((f) => f.endsWith('.js')).sort()) {
      const mod = require(path.join(modulesDir, file));
      ctx.modules[path.basename(file, '.js')] = mod;
    }
    for (const [name, mod] of Object.entries(ctx.modules)) {
      if (typeof mod.mount === 'function') {
        mod.mount(router, ctx);
        log('info', 'module.mounted', { name });
      }
    }
  }

  const server = http.createServer((req, res) => router.dispatch(req, res));
  return { db, router, server, ctx };
}

if (require.main === module) {
  const { server } = createApp();
  server.listen(PORT, '127.0.0.1', () => {
    log('info', 'server.listen', { port: PORT, url: `http://localhost:${PORT}` });
  });
}

module.exports = { createApp };
