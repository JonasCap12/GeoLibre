-- D1 schema for the GeoLibre projects and identity API.
--
-- A translation of the SQLAlchemy models in
-- backend/geolibre_server_api/geolibre_server_api/main.py, kept
-- column-for-column so an existing SQLite deployment can be imported with
-- `wrangler d1 execute --file` after a plain `.dump`. Timestamps are ISO 8601
-- UTC strings, not epoch integers, because the API returns them verbatim and
-- orders listings by them.
--
-- Apply with:
--   wrangler d1 execute geolibre-projects --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  -- Nullable: an external identity provider may create an account before the
  -- user picks a username. Project creation then fails with the `username
  -- required` sentinel the clients look for (see docs/server-api.md).
  username      TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  -- The SHA-256 hex digest of the bearer token, never the token itself.
  digest     TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_account ON tokens(account_id);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug           TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  visibility     TEXT NOT NULL,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  thumbnail_type TEXT,
  views          INTEGER NOT NULL DEFAULT 0,
  fork_count     INTEGER NOT NULL DEFAULT 0,
  featured       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- What makes concurrent slug allocation safe: the loser of a race fails this
  -- constraint and retries with the next candidate instead of overwriting.
  UNIQUE (owner_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);
-- Both public listings filter on visibility and order by updated_at.
CREATE INDEX IF NOT EXISTS idx_projects_visibility_updated ON projects(visibility, updated_at);

CREATE TABLE IF NOT EXISTS versions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, number)
);

CREATE TABLE IF NOT EXISTS project_activities (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: deleting an actor's account must not erase the
  -- owner's record that the event happened.
  actor_id   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  -- "<project>:<action>:<YYYY-MM-DD>" for the anonymous open/fetch events that
  -- aggregate, NULL for every per-event row. UNIQUE is load-bearing: it is what
  -- lets the upsert in activity.ts count concurrent anonymous hits without
  -- storing one row per visitor.
  bucket_key TEXT UNIQUE,
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_project_created ON project_activities(project_id, created_at);
