-- Invite, password-reset, and email-verification tokens, plus the account
-- columns they need.
--
-- D1 has no migration runner. Apply this file once, by hand, from the repo root:
--
--   npx wrangler d1 execute geolibre-projects --remote --file=workers/projects-api/schema-auth.sql -c workers/projects-api/wrangler.jsonc
--
-- DO NOT RE-RUN THE WHOLE FILE. `ALTER TABLE ... ADD COLUMN` is not
-- idempotent in SQLite: a second run stops on `duplicate column name: email`
-- and then nothing after that line runs. The CREATE INDEX and CREATE TABLE
-- statements are safe to repeat (`IF NOT EXISTS`). If a run died midway,
-- comment out the ALTER lines whose columns already exist and run the file
-- again. Check with:
--
--   npx wrangler d1 execute geolibre-projects --remote -c workers/projects-api/wrangler.jsonc --command "PRAGMA table_info(accounts);"
--
-- Existing accounts have NULL email and keep signing in with username and
-- password. Attach an address (after which password reset can find them) with:
--
--   UPDATE accounts
--      SET email = 'person@example.com',
--          email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
--    WHERE username = 'their-username';

ALTER TABLE accounts ADD COLUMN email TEXT;
ALTER TABLE accounts ADD COLUMN email_verified_at TEXT;
ALTER TABLE accounts ADD COLUMN password_changed_at TEXT;

-- Unique, but many rows may be NULL: the accounts created before this file
-- have no email and must keep working. SQLite treats NULLs as distinct in a
-- UNIQUE index, which is what makes that possible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email
  ON accounts(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_actions (
  -- SHA-256 of the token, never the token. Same reason as the tokens table:
  -- reading the database must not let you reset someone's password.
  digest      TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('invite','reset','verify')),
  -- NULL for an invite: the account does not exist when it is sent.
  -- 'verify' is reserved for a later phase; nothing in this change writes it.
  account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  -- Marked, not deleted, so "already used" stays distinguishable from
  -- "never existed" when something is being debugged.
  used_at     TEXT,
  created_by  TEXT REFERENCES accounts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_actions_email ON auth_actions(email, kind);
CREATE INDEX IF NOT EXISTS idx_auth_actions_expires ON auth_actions(expires_at);
