-- security-hardening: forced password change, login lockout counters, and
-- per-user token epochs for session revocation. The dormant sessions table is
-- deliberately untouched — revocation is epoch-based (inside the HMAC payload)
-- because serverless demo instances each have their own DB, so a denylist row
-- written by one instance would be invisible to the next.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;
ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;

-- Existing DBs: seeded well-known accounts must rotate before production use.
-- Enforcement is request-time and production-mode-only, so demo DBs are unaffected.
UPDATE users SET must_change_password = 1
 WHERE username IN ('admin','manager','cashier','gate');
