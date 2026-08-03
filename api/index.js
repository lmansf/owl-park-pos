'use strict';
// Vercel entry: the whole suite runs as one serverless function. The SQLite
// database lives in /tmp, so each warm instance seeds a fresh demo dataset on
// cold start — an intentionally ephemeral hosted demo (see /api/health).
const path = require('node:path');
const { createApp } = require('../server/main');

const DB_PATH = process.env.OWLPOS_DB || path.join('/tmp', 'owlpark-pos.db');
const { router } = createApp(DB_PATH);

module.exports = (req, res) => router.dispatch(req, res);
