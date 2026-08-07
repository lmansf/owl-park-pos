'use strict';
// Structured logging: one JSON object per line, so log processors never have to
// guess at a format and a crafted value (e.g. a username containing a newline)
// cannot forge extra records — every field goes through JSON.stringify.
// Never log credentials, session tokens, or whole req.headers/req.body objects.

function log(level, event, fields = {}) {
  const line = { ts: new Date().toISOString(), level, event, ...fields };
  (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}

function logError(event, err, fields = {}) {
  log('error', event, { ...fields, message: err.message, stack: err.stack });
}

module.exports = { log, logError };
