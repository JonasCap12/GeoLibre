# GeoLibre projects API on Workers

A port of [`backend/geolibre_server_api`](../../backend/geolibre_server_api) to
Workers + D1 + R2. Both implement version 1 of
[`docs/server-api.md`](../../docs/server-api.md), which defines the contract as
implementation-independent; that document, not either implementation, is the
authority.

This exists so the whole deployment can live on Cloudflare. The Python service
cannot: Workers runs V8 isolates, and SQLAlchemy with `psycopg` needs a native
extension.

## What is deliberately the same

- **Object keys** — `projects/<id>/versions/<n>.json` and
  `projects/<id>/thumbnail`. An existing S3/filesystem bucket can be copied into
  R2 unchanged, and an imported `versions.object_key` stays correct.
- **Password hashes** — scrypt, `n=2^14, r=8, p=1`, 64-byte key, stored as
  `scrypt$<salt hex>$<digest hex>`. An imported `accounts` table keeps working;
  nobody has to reset a password. Changing any parameter would make every stored
  hash unverifiable, so don't.
- **Table and column names** — so a `.dump` from the SQLite deployment imports
  with no rewriting.

## What is deliberately different

- **Rate limiting is implemented here.** `docs/server-api.md` lists it under
  "what the reference server leaves to the operator", to be supplied by a reverse
  proxy or WAF. The platform offers it directly, so the two unauthenticated
  scrypt routes (`POST /api/accounts`, `POST /api/auth/token`) are limited in the
  Worker instead of in a deployment footnote.
- **Atomic SQL replaces retry loops.** Version numbers are allocated by one
  `INSERT … SELECT MAX(number)+1 … RETURNING`, and anonymous activity buckets are
  counted by one `INSERT … ON CONFLICT DO UPDATE`. The reference needs
  read-then-write retries for the same guarantees because SQLAlchemy cannot
  express either portably.
- **`GEOLIBRE_CORS_ORIGINS` has no wildcard default.** The Python default is
  `*`; here the app and the API are on different hostnames, so an operator must
  name the app origin anyway, and forgetting should fail visibly in the browser
  rather than quietly accept every origin.
- **Paid plan required.** scrypt at `n=2^14` is 100–200 ms of CPU per login,
  which does not fit the 10 ms free-tier ceiling. `workers/tiles` has the same
  requirement for its reprojection path.

## Setup

```bash
# 1. Create the database and bucket, then paste the printed ids into wrangler.jsonc
wrangler d1 create geolibre-projects
wrangler r2 bucket create geolibre-projects

# 2. Apply the schema
wrangler d1 execute geolibre-projects --remote --file=schema.sql

# 3. Set the origins in wrangler.jsonc (GEOLIBRE_PUBLIC_URL, GEOLIBRE_VIEWER_URL,
#    GEOLIBRE_CORS_ORIGINS), create a rate-limit namespace id, then deploy
wrangler deploy
```

Point the web app at it with `VITE_GEOLIBRE_SHARE_URL` (see
`.github/workflows/deploy-web-worker.yml`). The value must be `https://`; the
app refuses a plaintext origin off loopback.

## Migrating from the Python deployment

```bash
# SQLite deployments: dump and import. Strip the Python-only bookkeeping first;
# the schema here is created by schema.sql, not by the dump.
sqlite3 geolibre-server-api.db .dump \
  | grep -v -E '^(CREATE|BEGIN|COMMIT|PRAGMA)' > data.sql
wrangler d1 execute geolibre-projects --remote --file=data.sql

# Objects: copy the bucket with any S3-compatible tool. Keys are unchanged.
rclone copy s3-old:geolibre-projects r2:geolibre-projects
```

A Postgres deployment needs the rows exported as SQLite-compatible `INSERT`
statements instead; the column names and order are identical, so only the dump
syntax differs.

## Known gaps

- **The Python test suite is not ported.** `backend/geolibre_server_api/tests/test_api.py`
  covers the behaviours above and is the stated conformance baseline along with
  the frontend tests for `share-geolibre.ts` and `share-gallery.ts`. Running it
  against this Worker needs `@cloudflare/vitest-pool-workers`, and until that
  exists this implementation is verified by typecheck and review only.
- **Token expiry** is absent, exactly as in the reference: tokens stay valid
  until `DELETE /api/auth/token` revokes them.
