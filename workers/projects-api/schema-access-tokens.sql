-- Apply before deploying the session-cookie API. Session revocation is checked
-- by JOIN on every request; no cascade or foreign-key setting is required.
CREATE TABLE IF NOT EXISTS access_tokens (
  digest TEXT PRIMARY KEY,
  session_digest TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS access_tokens_expires_at ON access_tokens(expires_at);
