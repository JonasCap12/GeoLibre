-- Shared dataset library.
--
-- Separate from schema.sql on purpose: that file is a column-for-column
-- translation of the SQLAlchemy models in backend/geolibre_server_api, so an
-- existing SQLite deployment can be imported with a plain `.dump`. This table
-- has no counterpart there — it is new to this deployment — and keeping it in
-- its own file keeps that import path exact.
--
-- WHAT IT IS FOR: projects already share a whole map. A team also needs to
-- share the *source files* — one person converts a 45 MB drawing once and
-- everyone else adds it as a layer, instead of each person holding a private
-- copy in their browser's IndexedDB (lib/layer-library-store.ts), where nobody
-- else can see it and a cleared cache loses it.
--
-- Apply with:
--   wrangler d1 execute geolibre-projects --remote --file=schema-datasets.sql

CREATE TABLE IF NOT EXISTS datasets (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Display name, free text. Distinct from `filename`: a team renames a file
  -- for the library ("Tim tuyen BL-LK") without losing what was uploaded.
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  -- The R2 key. Stored rather than derived so a future re-keying (or an
  -- imported bucket) does not need a migration of every row, exactly as the
  -- versions table stores object_key.
  object_key   TEXT NOT NULL,
  -- 'public'  -- anyone who can reach the API, which for an internal
  --              deployment is the team; this is what makes sharing work.
  -- 'private' -- only the uploader. Same vocabulary as projects.visibility
  --              minus 'unlisted', which has no meaning without a slug URL.
  visibility   TEXT NOT NULL DEFAULT 'public',
  -- Denormalised counter, incremented on each content read. Cheap signal for
  -- "is anyone actually using this", and avoids a join against the activity
  -- table for a listing.
  downloads    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- The library listing: visible rows, newest first.
CREATE INDEX IF NOT EXISTS idx_datasets_visibility_created
  ON datasets(visibility, created_at DESC);
-- "My uploads", and the cascade when an account is deleted.
CREATE INDEX IF NOT EXISTS idx_datasets_owner ON datasets(owner_id, created_at DESC);
