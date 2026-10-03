-- Session expiry and device columns, account disabling, and the auth audit log.
--
-- Requires schema-auth.sql to have been applied first (accounts.email).
--
-- D1 has no migration runner. Apply this file once, by hand, from the repo
-- root, BEFORE deploying the Worker that reads these columns. The Worker
-- selects them on every authenticated request, so deploying first turns every
-- signed-in call into a 500 until this runs:
--
--   npx wrangler d1 execute geolibre-projects --remote --file=workers/projects-api/schema-sessions-mfa.sql -c workers/projects-api/wrangler.jsonc
--
-- DO NOT RE-RUN THE WHOLE FILE. `ALTER TABLE ... ADD COLUMN` is not
-- idempotent in SQLite: a second run stops on `duplicate column name` and
-- nothing after that line runs. The CREATE statements are safe to repeat
-- (`IF NOT EXISTS`). If a run died midway, check which columns exist:
--
--   npx wrangler d1 execute geolibre-projects --remote -c workers/projects-api/wrangler.jsonc --command "PRAGMA table_info(tokens);"
--   npx wrangler d1 execute geolibre-projects --remote -c workers/projects-api/wrangler.jsonc --command "PRAGMA table_info(accounts);"
--
-- then comment out the ALTER lines whose columns are already listed and run
-- the file again.
--
-- Existing tokens get NULL in the new columns. The Worker treats a NULL expiry
-- as created_at + GEOLIBRE_SESSION_TTL_DAYS and a NULL last use as created_at,
-- so a token issued long ago is expired on the first request after deploy and
-- its owner signs in again with the same username and password.

-- tokens ------------------------------------------------------------------
-- Absolute end of the session (ASVS 5.0 V7.3.2).
ALTER TABLE tokens ADD COLUMN expires_at TEXT;
-- Idle timeout (V7.3.1). Written at most once an hour per token.
ALTER TABLE tokens ADD COLUMN last_used_at TEXT;
-- For the session list only. Truncated to 160 characters.
ALTER TABLE tokens ADD COLUMN user_agent TEXT;
ALTER TABLE tokens ADD COLUMN created_ip TEXT;
CREATE INDEX IF NOT EXISTS idx_tokens_expires ON tokens(expires_at);

-- accounts ----------------------------------------------------------------
-- Set by an admin. Every token of a disabled account answers 401.
ALTER TABLE accounts ADD COLUMN disabled_at TEXT;

-- auth_events -------------------------------------------------------------
-- Security events (ASVS 5.0 V16). Never holds a password, a token, or a
-- one-time code; `detail` is a short JSON object of identifiers and outcomes.
-- Pruned past GEOLIBRE_ACTIVITY_RETENTION_DAYS on every insert.
CREATE TABLE IF NOT EXISTS auth_events (
  id          TEXT PRIMARY KEY,
  -- SET NULL, not CASCADE: deleting an account must not erase the record of
  -- what happened to it.
  account_id  TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at);
CREATE INDEX IF NOT EXISTS idx_auth_events_account ON auth_events(account_id, kind);
