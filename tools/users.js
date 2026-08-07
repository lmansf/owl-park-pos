'use strict';
// Operator account management: node tools/users.js <command> [username] [--db <path>]
//   list                      show every account (never prints hashes)
//   activate <username>       enable the account and set a temporary password
//   set-password <username>   set a temporary password on an existing account
//   deactivate <username>     disable the account (refuses the last active admin)
// activate/set-password read the new password from the OWLPOS_USER_PASSWORD env var —
// never argv, which leaks into shell history and ps. The password is stamped
// must_change_password, so in production mode the holder is fenced into rotating it on
// first login; token_epoch is bumped so any existing session for the account dies.
// Plain transactional writes: safe whether or not the server is running.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, audit } = require('../server/core/auth');

const ROOT = path.join(__dirname, '..');
const MIN_PASSWORD = 8;
const USAGE =
  'usage: node tools/users.js <list|activate|deactivate|set-password> [username] [--db <path>]';

function fail(msg) {
  console.error(`users: ${msg}`);
  process.exit(1);
}

function requirePassword(username) {
  const password = String(process.env.OWLPOS_USER_PASSWORD || '');
  if (password.length < MIN_PASSWORD) {
    fail(`set OWLPOS_USER_PASSWORD (>= ${MIN_PASSWORD} chars) — passwords are read from the ` +
      'environment, never from arguments');
  }
  if (password.toLowerCase() === username) {
    fail('the password must not equal the username — that is the demo credential pattern');
  }
  return password;
}

function main() {
  const args = process.argv.slice(2);
  const dbFlag = args.indexOf('--db');
  const dbPath = dbFlag >= 0
    ? args[dbFlag + 1]
    : process.env.OWLPOS_DB || path.join(ROOT, 'data', 'owlpark-pos.db');
  const positional = args.filter((a, i) => !a.startsWith('--') && (dbFlag < 0 || i !== dbFlag + 1));
  const command = positional[0];
  const username = String(positional[1] || '').toLowerCase();

  if (!command) fail(USAGE);
  if (!dbPath || !fs.existsSync(dbPath)) {
    fail(`database not found: ${dbPath} (start the server once, or pass --db)`);
  }
  const db = new DatabaseSync(dbPath);

  if (command === 'list') {
    for (const u of db
      .prepare('SELECT username, display_name, role, active, must_change_password FROM users ORDER BY id')
      .all()) {
      console.log(
        `${u.username.padEnd(12)} ${u.role.padEnd(8)} ` +
        `${u.active ? 'active  ' : 'disabled'} ` +
        `${u.must_change_password ? 'must-change-password' : ''} (${u.display_name})`
      );
    }
    db.close();
    return;
  }

  if (!['activate', 'deactivate', 'set-password'].includes(command)) fail(USAGE);
  if (!username) fail(`${command} needs a username — ${USAGE}`);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) { db.close(); fail(`no account "${username}" (try: node tools/users.js list)`); }

  if (command === 'deactivate') {
    const otherAdmins = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?")
      .get(user.id).n;
    if (user.role === 'admin' && user.active && otherAdmins === 0) {
      db.close();
      fail('refusing to deactivate the last active admin — you would be locked out');
    }
    db.prepare('UPDATE users SET active = 0, token_epoch = token_epoch + 1 WHERE id = ?')
      .run(user.id);
    audit(db, null, 'users.deactivate', { username });
    console.log(`users: ${username} deactivated; existing sessions revoked`);
  } else {
    const password = requirePassword(username);
    db.prepare(
      `UPDATE users SET pass_hash = ?, must_change_password = 1, failed_logins = 0,
         locked_until = NULL, token_epoch = token_epoch + 1
         ${command === 'activate' ? ', active = 1' : ''}
       WHERE id = ?`
    ).run(hashPassword(password), user.id);
    audit(db, null, command === 'activate' ? 'users.activate' : 'users.set_password', { username });
    console.log(
      `users: ${username} ${command === 'activate' ? 'activated' : 'password set'}; ` +
      'the temporary password must be changed on first production login'
    );
  }
  db.close();
}

main();
