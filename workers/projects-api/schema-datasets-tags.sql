-- Tags and search for the shared data library.
--
-- Run after schema-datasets.sql:
--   wrangler d1 execute geolibre-projects --remote --file=workers/projects-api/schema-datasets-tags.sql
--
-- Separate from schema-datasets.sql because that file is the table's original
-- shape and some deployments have already run it; D1 has no migration runner,
-- so each change ships as its own idempotent file.
--
-- WHY THIS EXISTS
--
-- With five datasets a list is enough. With fifty projects' worth of drawings
-- it is not: the library becomes a place things go in and never come out of,
-- which is worse than no library at all because people stop trusting it.
--
-- WHY TAGS ARE A STRING, NOT A TABLE
--
-- A join table is the textbook answer and the wrong one here. Tags on a
-- dataset are read on every listing and written only with the dataset itself,
-- so a join costs a query per page to model a relationship that is never
-- queried from the other side. D1 bills rows read. A normalised design would
-- be correct and slower and more expensive, for a set that holds a handful of
-- short words.
--
-- The column stores tags comma-separated, each already trimmed and lowercased
-- by the API, with a leading and trailing comma so that `tags LIKE '%,road,%'`
-- matches a whole tag and never a fragment of another ("road" must not match
-- "railroad"). An empty set is stored as '' rather than ',,' so a dataset with
-- no tags matches no tag filter.

ALTER TABLE datasets ADD COLUMN tags TEXT NOT NULL DEFAULT '';

-- Listing filtered by tag still scans, because LIKE with a leading wildcard
-- cannot use an index. At the scale this library is for -- thousands of rows,
-- not millions -- a scan of one narrow column is cheaper than the writes and
-- reads a join table would add. Revisit if a deployment passes ~100k datasets.
CREATE INDEX IF NOT EXISTS idx_datasets_tags ON datasets(tags);
