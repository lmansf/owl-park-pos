'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, migrate } = require('./core/db');
const { Router } = require('./core/http');
const auth = require('./core/auth');
const { seed } = require('./core/seed');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.OWLPOS_PORT || 4650);
const DB_PATH = process.env.OWLPOS_DB || path.join(ROOT, 'data', 'owlpark-pos.db');

function createApp(dbPath = DB_PATH) {
  const db = openDb(dbPath);
  migrate(db, path.join(__dirname, 'migrations'));
  if (seed(db)) console.log('[seed] demo data created');

  const router = new Router({
    webRoot: path.join(ROOT, 'web'),
    resolveUser: auth.resolveUser(db),
  });
  auth.mount(router, db);

  // Auto-mount every module in server/modules/ (each exports mount(router, ctx))
  const ctx = { db, modules: {} };
  const modulesDir = path.join(__dirname, 'modules');
  if (fs.existsSync(modulesDir)) {
    for (const file of fs.readdirSync(modulesDir).filter((f) => f.endsWith('.js')).sort()) {
      const mod = require(path.join(modulesDir, file));
      ctx.modules[path.basename(file, '.js')] = mod;
    }
    for (const [name, mod] of Object.entries(ctx.modules)) {
      if (typeof mod.mount === 'function') {
        mod.mount(router, ctx);
        console.log(`[module] mounted ${name}`);
      }
    }
  }

  const server = http.createServer((req, res) => router.dispatch(req, res));
  return { db, router, server, ctx };
}

if (require.main === module) {
  const { server } = createApp();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`owl-park-pos on http://localhost:${PORT}  (store: /store/)`);
  });
}

module.exports = { createApp };
