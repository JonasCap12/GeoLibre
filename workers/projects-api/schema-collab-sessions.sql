-- An account's saved collaboration sessions (src/collab-sessions.ts).
--
-- Safe to run more than once: it only creates what is missing. Apply it
-- BEFORE deploying the Worker that reads it (scripts/predeploy-check.mjs
-- refuses to deploy until the table exists):
--
--   npx wrangler d1 execute geolibre-projects --remote --file=workers/projects-api/schema-collab-sessions.sql -c workers/projects-api/wrangler.jsonc

CREATE TABLE IF NOT EXISTS collab_sessions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The relay's eight-character session code.
  code            TEXT NOT NULL,
  -- What the owner calls it: usually the team or group it is for.
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('co-edit', 'view-only')),
  -- The relay's host token, AES-GCM sealed with MFA_ENCRYPTION_KEY and bound to
  -- the account. Never stored or returned in the clear to anyone but the owner.
  host_token      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_opened_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_sessions_owner_code
  ON collab_sessions(account_id, code);
