// GeoLibre projects and identity API, version 1.
//
// Implements docs/server-api.md on Workers + D1 + R2. That document is the
// authority: it defines the contract as implementation-independent, and
// backend/geolibre_server_api is one reference implementation of it. Where this
// file diverges from the Python module it is noted inline, and only ever because
// the platform offers a stronger primitive (atomic upserts and RETURNING replace
// retry loops) or because the contract asks for something the reference
// explicitly leaves to the operator (rate limiting).

import { burnPasswordHash, mintToken, passwordHash, passwordMatches, tokenDigest } from "./auth";
import {
  ApiError,
  IMAGE_TYPES,
  PROJECT_SELECT,
  USERNAME_RE,
  accountJson,
  activityJson,
  activityStatements,
  now,
  owned,
  parseContent,
  projectJson,
  slugify,
  titleFrom,
  visible,
  type AccountRow,
  type ActivityRow,
  type Config,
  type ProjectRow,
  type Visibility,
} from "./model";
import { objectStorage, thumbnailKey, versionKey, type Objects } from "./storage";

interface Env {
  DB: D1Database;
  OBJECTS: R2Bucket;
  GEOLIBRE_PUBLIC_URL?: string;
  GEOLIBRE_VIEWER_URL?: string;
  GEOLIBRE_CORS_ORIGINS?: string;
  GEOLIBRE_MAX_PROJECT_BYTES?: string;
  GEOLIBRE_MAX_THUMBNAIL_BYTES?: string;
  GEOLIBRE_ACTIVITY_RETENTION_DAYS?: string;
  AUTH_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const VISIBILITIES = new Set(["public", "unlisted", "private"]);

function readConfig(env: Env): Config {
  const integer = (raw: string | undefined, fallback: number): number => {
    const value = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    baseUrl: (env.GEOLIBRE_PUBLIC_URL ?? "http://localhost:8000").replace(/\/+$/, ""),
    // Always exactly one trailing slash, as the reference builds it, so
    // viewerUrl reads https://host/?project=… rather than https://host?project=…
    viewerUrl: `${(env.GEOLIBRE_VIEWER_URL ?? "https://app.geolibre.org").replace(/\/+$/, "")}/`,
    maxProjectBytes: integer(env.GEOLIBRE_MAX_PROJECT_BYTES, 50 * 1024 * 1024),
    maxThumbnailBytes: integer(env.GEOLIBRE_MAX_THUMBNAIL_BYTES, 5 * 1024 * 1024),
    activityRetentionDays: integer(env.GEOLIBRE_ACTIVITY_RETENTION_DAYS, 90),
    corsOrigins: (env.GEOLIBRE_CORS_ORIGINS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(request: Request, config: Config): Record<string, string> {
  const origin = request.headers.get("Origin");
  // A "*" anywhere in the list means allow-all, and allow-all must never be
  // paired with credentials -- the reference makes the same call, because
  // "*,https://app.example" would otherwise accept credentialed requests from
  // any origin on the internet.
  if (config.corsOrigins.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    };
  }
  if (origin === null || !config.corsOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const empty = (status: number): Response => new Response(null, { status });

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(422, "request body must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function positiveInt(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ApiError(422, `${name} must be an integer`);
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new ApiError(422, `${name} must be between ${min} and ${max}`);
  }
  return value;
}

function boolParam(url: URL, name: string): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return false;
  const value = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new ApiError(422, `${name} must be a boolean`);
}

function requireVisibility(value: unknown, field = "visibility"): Visibility {
  if (typeof value !== "string" || !VISIBILITIES.has(value)) {
    throw new ApiError(422, `${field} must be public, unlisted, or private`);
  }
  return value as Visibility;
}

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * Reads a body with a hard cap, abandoning the stream as soon as the cap is
 * exceeded. `await request.arrayBuffer()` would materialize the whole upload
 * before the size could be checked, letting an authenticated caller push a
 * multi-gigabyte body just to earn a 413.
 */
async function readCapped(request: Request, limit: number, onTooLarge: () => ApiError) {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number.parseInt(declared, 10) > limit) {
    throw onTooLarge();
  }
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw onTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function optionalAccount(request: Request, db: D1Database): Promise<AccountRow | null> {
  const header = request.headers.get("Authorization");
  if (header === null || header === "") return null;
  if (!header.startsWith("Bearer ")) throw new ApiError(401, "invalid authorization");
  const account = await db
    .prepare(
      `SELECT a.* FROM accounts a JOIN tokens t ON t.account_id = a.id WHERE t.digest = ?`,
    )
    .bind(await tokenDigest(header.slice(7)))
    .first<AccountRow>();
  if (account === null) throw new ApiError(401, "invalid or expired token");
  return account;
}

function requireAccount(account: AccountRow | null): AccountRow {
  if (account === null) throw new ApiError(401, "authentication required");
  return account;
}

// ---------------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------------

const projectById = (db: D1Database, id: string): Promise<ProjectRow | null> =>
  db
    .prepare(`${PROJECT_SELECT} WHERE p.id = ?`)
    .bind(id)
    .first<ProjectRow>();

const projectByPath = (db: D1Database, username: string, slug: string): Promise<ProjectRow | null> =>
  db
    .prepare(`${PROJECT_SELECT} WHERE a.username = ? AND p.slug = ?`)
    .bind(username, slug)
    .first<ProjectRow>();

async function uniqueSlug(db: D1Database, ownerId: string, desired: string): Promise<string> {
  const base = slugify(desired);
  let candidate = base;
  let suffix = 2;
  for (;;) {
    const taken = await db
      .prepare(`SELECT id FROM projects WHERE owner_id = ? AND slug = ?`)
      .bind(ownerId, candidate)
      .first<{ id: string }>();
    if (taken === null) return candidate;
    const tail = `-${suffix}`;
    candidate = base.slice(0, 100 - tail.length).replace(/-+$/g, "") + tail;
    suffix += 1;
  }
}

/**
 * Creates a project and its first immutable version.
 *
 * uniqueSlug SELECTs and this INSERTs, so two concurrent creates from one
 * account with the same title can pick the same slug; the loser fails the
 * (owner_id, slug) constraint and the allocation is retried rather than
 * surfacing as a 500.
 */
async function createProject(
  db: D1Database,
  objects: Objects,
  config: Config,
  account: AccountRow,
  content: string,
  filename: string,
  visibility: Visibility,
): Promise<string> {
  if (!account.username) throw new ApiError(400, "username required");
  const document = parseContent(content, config.maxProjectBytes);
  const title = titleFrom(document, filename);
  const timestamp = now();

  let projectId = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    projectId = crypto.randomUUID();
    const slug = await uniqueSlug(db, account.id, title || filename);
    try {
      await db
        .prepare(
          `INSERT INTO projects
             (id, owner_id, slug, title, description, visibility, tags_json,
              thumbnail_type, views, fork_count, featured, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', ?, '[]', NULL, 0, 0, 0, ?, ?)`,
        )
        .bind(projectId, account.id, slug, title, visibility, timestamp, timestamp)
        .run();
      break;
    } catch (error) {
      if (attempt === 4) throw new ApiError(409, "could not allocate a project slug; retry");
      // Only a slug collision is retryable; anything else is a real failure and
      // must not be masked by four more attempts.
      if (!String(error).includes("UNIQUE")) throw error;
    }
  }

  // The object is written before the version row so a crash between the two
  // leaves an orphaned object rather than a version row pointing at nothing --
  // the first is invisible, the second is a 404 on a project that looks fine.
  const key = versionKey(projectId, 1);
  await objects.put(key, new TextEncoder().encode(content), "application/json");
  await db
    .prepare(
      `INSERT INTO versions (project_id, number, object_key, created_at) VALUES (?, 1, ?, ?)`,
    )
    .bind(projectId, key, timestamp)
    .run();
  return projectId;
}

function rawResponse(content: ArrayBuffer, project: ProjectRow, immutable: boolean): Response {
  const cache =
    project.visibility === "private"
      ? "private, no-store"
      : immutable
        ? "public, max-age=3600"
        : "public, max-age=60";
  return new Response(content, {
    headers: { "Content-Type": "application/json", "Cache-Control": cache },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env, config: Config): Promise<Response> {
  const url = new URL(request.url);
  // Decoded, because a username or slug arrives percent-encoded and every
  // lookup below compares it against the stored value.
  const segments = url.pathname
    .split("/")
    .filter((part) => part !== "")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw new ApiError(422, "malformed path");
      }
    });
  const method = request.method;
  const db = env.DB;
  const objects = objectStorage(env.OBJECTS);

  // A declared Content-Length past the largest thing any route accepts is
  // rejected before the body is read. The factor of six is the worst case, not a
  // typical one: the per-route check bounds the *decoded* string, and JSON may
  // encode any ASCII byte as a six-byte \u00XX escape, so a legitimate document
  // at the limit can be six times that on the wire. A tighter bound would reject
  // valid uploads.
  const bodyCeiling = Math.max(config.maxProjectBytes * 6, config.maxThumbnailBytes) + 1024;
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number.parseInt(declared, 10) > bodyCeiling) {
    throw new ApiError(413, "request body too large");
  }

  if (segments.length === 1 && segments[0] === "health" && method === "GET") {
    return json({ ok: true, service: "geolibre-server" });
  }

  if (segments[0] === "api") {
    return await apiRoute(request, env, config, db, objects, url, segments.slice(1), method);
  }

  // Website-compatible routes. Checked last so they cannot shadow /api or
  // /health, and only for a two-segment path, which is all the contract defines.
  if (segments.length === 2 && method === "GET") {
    const [username, tail] = segments;
    const account = await optionalAccount(request, db);
    const actorId = account?.id ?? null;

    if (tail.endsWith(".geolibre.json")) {
      const slug = tail.slice(0, -".geolibre.json".length);
      const project = visible(await projectByPath(db, username, slug), actorId);
      const latest = await db
        .prepare(
          `SELECT number, object_key FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT 1`,
        )
        .bind(project.id)
        .first<{ number: number; object_key: string }>();
      if (latest === null) throw new ApiError(404, "project content not found");
      const content = await objects.get(latest.object_key);
      // Read the object first: a missing object is a 404 that must not count as
      // a view.
      if (content === null) throw new ApiError(404, "project content not found");
      await db.batch([
        db.prepare(`UPDATE projects SET views = views + 1 WHERE id = ?`).bind(project.id),
        ...activityStatements(db, config, project.id, actorId, "fetch", { version: latest.number }),
      ]);
      return rawResponse(content, project, false);
    }

    const project = visible(await projectByPath(db, username, tail), actorId);
    await db.batch(activityStatements(db, config, project.id, actorId, "open"));
    const raw = `${config.baseUrl}/${encodeURIComponent(username)}/${encodeURIComponent(tail)}.geolibre.json`;
    return new Response(null, {
      status: 302,
      headers: { Location: `${config.viewerUrl}?project=${encodeURIComponent(raw)}` },
    });
  }

  throw new ApiError(404, "not found");
}

async function apiRoute(
  request: Request,
  env: Env,
  config: Config,
  db: D1Database,
  objects: Objects,
  url: URL,
  path: string[],
  method: string,
): Promise<Response> {
  // --- Identity ----------------------------------------------------------
  if (path.length === 1 && path[0] === "accounts" && method === "POST") {
    await rateLimit(env, request, "accounts");
    const body = await readJsonBody(request);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (username.length > 39 || password.length > 1024) {
      // Both fields feed scrypt, so an unbounded body would let a caller drive
      // its ~16 MiB-per-call cost.
      throw new ApiError(422, "username or password is too long");
    }
    if (!USERNAME_RE.test(username)) {
      throw new ApiError(422, "username must be 3-39 lowercase letters, digits, or hyphens");
    }
    if (password.length < 8) throw new ApiError(422, "password must be at least 8 characters");

    const account: AccountRow = {
      id: crypto.randomUUID(),
      username,
      password_hash: await passwordHash(password),
      created_at: now(),
    };
    try {
      await db
        .prepare(
          `INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(account.id, account.username, account.password_hash, account.created_at)
        .run();
    } catch (error) {
      // The uniqueness check and the insert are not atomic, so racing requests
      // can both pass it. The contract makes a uniqueness conflict a 409, not
      // the 500 an unhandled constraint error would produce.
      if (String(error).includes("UNIQUE")) throw new ApiError(409, "username already exists");
      throw error;
    }
    return json({ account: accountJson(account), token: await issueToken(db, account.id) }, 201);
  }

  if (path.length === 2 && path[0] === "auth" && path[1] === "token") {
    if (method === "POST") {
      await rateLimit(env, request, "token");
      const body = await readJsonBody(request);
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (username.length > 39 || password.length > 1024) {
        throw new ApiError(422, "username or password is too long");
      }
      const account = await db
        .prepare(`SELECT * FROM accounts WHERE username = ?`)
        .bind(username)
        .first<AccountRow>();
      if (account === null) {
        // Hash anyway before failing. Short-circuiting would skip the scrypt
        // call a real username always pays for, and the timing difference
        // enumerates accounts one request at a time -- which a request-count
        // rate limiter does not address.
        await burnPasswordHash(password);
        throw new ApiError(401, "invalid username or password");
      }
      if (!(await passwordMatches(password, account.password_hash))) {
        throw new ApiError(401, "invalid username or password");
      }
      return json({ account: accountJson(account), token: await issueToken(db, account.id) });
    }
    if (method === "DELETE") {
      const header = request.headers.get("Authorization");
      requireAccount(await optionalAccount(request, db));
      await db
        .prepare(`DELETE FROM tokens WHERE digest = ?`)
        .bind(await tokenDigest((header as string).slice(7)))
        .run();
      return empty(204);
    }
  }

  if (path.length === 1 && path[0] === "account" && method === "GET") {
    const account = requireAccount(await optionalAccount(request, db));
    return json({ account: accountJson(account) }, 200, { "Cache-Control": "private, no-store" });
  }

  if (path.length === 2 && path[0] === "users" && path[1] === "me" && method === "GET") {
    const account = requireAccount(await optionalAccount(request, db));
    return json({ user: accountJson(account) }, 200, { "Cache-Control": "private, no-store" });
  }

  if (path.length === 3 && path[0] === "users" && path[2] === "projects" && method === "GET") {
    const limit = positiveInt(url, "limit", 24, 1, 100);
    const offset = positiveInt(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const account = await optionalAccount(request, db);
    const owner = await db
      .prepare(`SELECT id FROM accounts WHERE username = ?`)
      .bind(path[1])
      .first<{ id: string }>();
    if (owner === null) throw new ApiError(404, "user not found");
    // A non-owner gets a filtered 200, not a 403: the listing narrows rather
    // than refusing, which keeps a user's existence from being probed through
    // the status code.
    const own = account !== null && account.id === owner.id;
    const rows = await db
      .prepare(
        `${PROJECT_SELECT} WHERE p.owner_id = ?${own ? "" : " AND p.visibility = 'public'"}
         ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(owner.id, limit, offset)
      .all<ProjectRow>();
    return json({ projects: rows.results.map((row) => projectJson(row, config)) });
  }

  // --- Projects ----------------------------------------------------------
  if (path.length === 1 && path[0] === "projects") {
    if (method === "POST") {
      const account = requireAccount(await optionalAccount(request, db));
      const body = await readJsonBody(request);
      const content = typeof body.content === "string" ? body.content : "";
      const filename = typeof body.filename === "string" ? body.filename : "";
      if (filename.length > 255) throw new ApiError(422, "filename is too long");
      const visibility = requireVisibility(body.visibility);
      const id = await createProject(
        db,
        objects,
        config,
        account,
        content,
        filename,
        visibility,
      );
      const project = await projectById(db, id);
      return json({ project: projectJson(project as ProjectRow, config) }, 201);
    }

    if (method === "GET") {
      const limit = positiveInt(url, "limit", 24, 1, 100);
      const offset = positiveInt(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const featured = boolParam(url, "featured");
      const mine = boolParam(url, "mine");
      const account = await optionalAccount(request, db);

      const filters: string[] = [];
      const binds: unknown[] = [];
      if (mine) {
        // An Authorization header does not broaden a public listing by itself;
        // only mine=true does, and then a token is mandatory.
        const owner = requireAccount(account);
        filters.push("p.owner_id = ?");
        binds.push(owner.id);
      } else {
        filters.push("p.visibility = 'public'");
      }
      if (featured) filters.push("p.featured = 1");
      const where = `WHERE ${filters.join(" AND ")}`;

      const rows = await db
        .prepare(`${PROJECT_SELECT} ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`)
        .bind(...binds, limit, offset)
        .all<ProjectRow>();
      const counted = await db
        .prepare(`SELECT COUNT(*) AS total FROM projects p ${where}`)
        .bind(...binds)
        .first<{ total: number }>();
      return json({
        projects: rows.results.map((row) => projectJson(row, config)),
        limit,
        offset,
        total: counted?.total ?? 0,
      });
    }
  }

  if (path.length >= 2 && path[0] === "projects") {
    const projectId = path[1];

    if (path.length === 2 && method === "GET") {
      const account = await optionalAccount(request, db);
      const project = visible(await projectById(db, projectId), account?.id ?? null);
      // Only the private case gets a policy. The contract requires `private,
      // no-store` there; it says nothing about caching public metadata, and
      // inventing a max-age here would serve stale titles and visibility after
      // an edit.
      return json(
        { project: projectJson(project, config) },
        200,
        project.visibility === "private" ? { "Cache-Control": "private, no-store" } : {},
      );
    }

    if (path.length === 2 && method === "PATCH") {
      const account = requireAccount(await optionalAccount(request, db));
      const project = owned(await projectById(db, projectId), account.id);
      const body = await readJsonBody(request);

      const assignments: string[] = [];
      const binds: unknown[] = [];
      let nextVisibility = project.visibility;

      // Only fields actually present in the body are applied, and a field sent
      // as an explicit null is present: without these guards a null visibility
      // reaches a NOT NULL column and null tags reach a length check, both of
      // which surface as a 500 instead of the documented 422.
      if ("title" in body) {
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (title === "") throw new ApiError(422, "title must not be empty");
        if (codePoints(title) > 100) throw new ApiError(422, "title must not exceed 100 characters");
        assignments.push("title = ?");
        binds.push(title);
      }
      if ("description" in body) {
        const description = typeof body.description === "string" ? body.description : "";
        if (codePoints(description) > 2000) {
          throw new ApiError(422, "description must not exceed 2000 characters");
        }
        assignments.push("description = ?");
        binds.push(description);
      }
      if ("visibility" in body) {
        nextVisibility = requireVisibility(body.visibility);
        assignments.push("visibility = ?");
        binds.push(nextVisibility);
      }
      if ("tags" in body) {
        const tags = body.tags ?? [];
        if (
          !Array.isArray(tags) ||
          tags.length > 20 ||
          tags.some((tag) => typeof tag !== "string" || tag === "" || codePoints(tag) > 40)
        ) {
          throw new ApiError(422, "tags must contain at most 20 non-empty 40-character tags");
        }
        assignments.push("tags_json = ?");
        binds.push(JSON.stringify(tags));
      }

      assignments.push("updated_at = ?");
      binds.push(now());
      const statements = [
        db
          .prepare(`UPDATE projects SET ${assignments.join(", ")} WHERE id = ?`)
          .bind(...binds, project.id),
      ];
      if (nextVisibility !== project.visibility) {
        statements.push(
          ...activityStatements(db, config, project.id, account.id, "visibility_change", {
            before: project.visibility,
            after: nextVisibility,
          }),
        );
      }
      await db.batch(statements);
      return json({ project: projectJson((await projectById(db, project.id)) as ProjectRow, config) });
    }

    if (path.length === 2 && method === "DELETE") {
      const account = requireAccount(await optionalAccount(request, db));
      const project = owned(await projectById(db, projectId), account.id);
      // Rows first (versions, activity and tokens cascade), then objects: an
      // orphaned object is invisible, whereas a row pointing at a deleted object
      // is a 404 on a project that still lists.
      await db.prepare(`DELETE FROM projects WHERE id = ?`).bind(project.id).run();
      await objects.deleteProject(project.id);
      return empty(204);
    }

    if (path.length === 3 && path[2] === "activity") {
      const account = requireAccount(await optionalAccount(request, db));
      const project = owned(await projectById(db, projectId), account.id);
      if (method === "GET") {
        const rows = await db
          .prepare(
            `SELECT id, action, actor_id, details_json, bucket_key, count, created_at
             FROM project_activities WHERE project_id = ?
             ORDER BY created_at DESC LIMIT 100`,
          )
          .bind(project.id)
          .all<ActivityRow>();
        return json({ activity: rows.results.map(activityJson) }, 200, {
          "Cache-Control": "private, no-store",
        });
      }
      if (method === "DELETE") {
        await db
          .prepare(`DELETE FROM project_activities WHERE project_id = ?`)
          .bind(project.id)
          .run();
        return empty(204);
      }
    }

    if (path.length === 3 && path[2] === "content" && method === "PUT") {
      const account = requireAccount(await optionalAccount(request, db));
      const project = owned(await projectById(db, projectId), account.id);
      const body = await readJsonBody(request);
      const content = typeof body.content === "string" ? body.content : "";
      parseContent(content, config.maxProjectBytes);

      // One atomic statement allocates the number and reserves the row, so
      // concurrent updates cannot pick the same one. The reference needs a
      // read-then-insert retry loop here, which is exactly how two updates once
      // wrote the same storage key and the winner's content was overwritten.
      // The key is built in SQL from the number the same statement allocates, so
      // it matches versionKey() exactly without a second write to correct it.
      const reserved = await db
        .prepare(
          `INSERT INTO versions (project_id, number, object_key, created_at)
           SELECT ?1,
                  COALESCE(MAX(number), 0) + 1,
                  'projects/' || ?1 || '/versions/' || (COALESCE(MAX(number), 0) + 1) || '.json',
                  ?2
           FROM versions WHERE project_id = ?1
           RETURNING number, object_key`,
        )
        .bind(project.id, now())
        .first<{ number: number; object_key: string }>();
      if (reserved === null) throw new ApiError(409, "could not allocate a version number; retry");

      const number = reserved.number;
      if (reserved.object_key !== versionKey(project.id, number)) {
        // The two must agree or a later read looks for the wrong object. Fail
        // loudly rather than storing content under a key nothing will fetch.
        throw new ApiError(500, "version key mismatch");
      }
      await objects.put(reserved.object_key, new TextEncoder().encode(content), "application/json");
      await db.batch([
        db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(now(), project.id),
        ...activityStatements(db, config, project.id, account.id, "version_save", { version: number }),
      ]);
      return json(
        {
          project: projectJson((await projectById(db, project.id)) as ProjectRow, config),
          version: number,
        },
        201,
      );
    }

    if (path.length === 3 && path[2] === "forks" && method === "POST") {
      const account = requireAccount(await optionalAccount(request, db));
      const source = visible(await projectById(db, projectId), account.id);
      // The body is optional: "fork this project" with no options is the common
      // call, and omitting it entirely must behave as {"visibility":"private"}
      // rather than returning 422.
      const body = await readJsonBody(request);
      const visibility = "visibility" in body ? requireVisibility(body.visibility) : "private";

      const latest = await db
        .prepare(
          `SELECT object_key FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT 1`,
        )
        .bind(source.id)
        .first<{ object_key: string }>();
      if (latest === null) throw new ApiError(404, "project content not found");
      const content = await objects.get(latest.object_key);
      if (content === null) throw new ApiError(404, "project content not found");

      const forkId = await createProject(
        db,
        objects,
        config,
        account,
        new TextDecoder().decode(content),
        `${source.title}.geolibre.json`,
        visibility,
      );
      // Incremented in SQL rather than read-modify-write, so concurrent forks
      // cannot lose each other's increments; the contract promises this counter
      // rises atomically.
      await db.batch([
        db.prepare(`UPDATE projects SET fork_count = fork_count + 1 WHERE id = ?`).bind(source.id),
        ...activityStatements(db, config, source.id, account.id, "fork", {
          forked_project_id: forkId,
        }),
      ]);
      return json({ project: projectJson((await projectById(db, forkId)) as ProjectRow, config) }, 201);
    }

    if (path.length === 4 && path[2] === "versions" && method === "GET") {
      if (!/^\d+$/.test(path[3])) throw new ApiError(422, "version must be an integer");
      const number = Number.parseInt(path[3], 10);
      const account = await optionalAccount(request, db);
      const actorId = account?.id ?? null;
      const project = visible(await projectById(db, projectId), actorId);
      const versionRow = await db
        .prepare(`SELECT object_key FROM versions WHERE project_id = ? AND number = ?`)
        .bind(project.id, number)
        .first<{ object_key: string }>();
      if (versionRow === null) throw new ApiError(404, "project version not found");
      const content = await objects.get(versionRow.object_key);
      if (content === null) throw new ApiError(404, "project content not found");
      await db.batch(
        activityStatements(db, config, project.id, actorId, "fetch", { version: number }),
      );
      return rawResponse(content, project, true);
    }

    if (path.length === 3 && path[2] === "thumbnail") {
      if (method === "PUT") {
        const account = requireAccount(await optionalAccount(request, db));
        const project = owned(await projectById(db, projectId), account.id);
        const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
        if (!IMAGE_TYPES.has(contentType)) {
          throw new ApiError(422, "thumbnail must be PNG, JPEG, or WebP");
        }
        const data = await readCapped(
          request,
          config.maxThumbnailBytes,
          () =>
            new ApiError(413, `thumbnail exceeds the ${config.maxThumbnailBytes} byte limit`),
        );
        await objects.put(thumbnailKey(project.id), data, contentType);
        await db
          .prepare(`UPDATE projects SET thumbnail_type = ?, updated_at = ? WHERE id = ?`)
          .bind(contentType, now(), project.id)
          .run();
        return empty(204);
      }
      if (method === "GET") {
        const account = await optionalAccount(request, db);
        const project = visible(await projectById(db, projectId), account?.id ?? null);
        if (!project.thumbnail_type) throw new ApiError(404, "thumbnail not found");
        const data = await objects.get(thumbnailKey(project.id));
        if (data === null) throw new ApiError(404, "thumbnail not found");
        return new Response(data, {
          headers: {
            "Content-Type": project.thumbnail_type,
            "Cache-Control":
              project.visibility === "private" ? "private, no-store" : "public, max-age=3600",
          },
        });
      }
      if (method === "DELETE") {
        const account = requireAccount(await optionalAccount(request, db));
        const project = owned(await projectById(db, projectId), account.id);
        await objects.delete(thumbnailKey(project.id));
        await db
          .prepare(`UPDATE projects SET thumbnail_type = NULL, updated_at = ? WHERE id = ?`)
          .bind(now(), project.id)
          .run();
        return empty(204);
      }
    }
  }

  throw new ApiError(404, "not found");
}

async function issueToken(db: D1Database, accountId: string): Promise<string> {
  const token = mintToken();
  await db
    .prepare(`INSERT INTO tokens (digest, account_id, created_at) VALUES (?, ?, ?)`)
    .bind(await tokenDigest(token), accountId, now())
    .run();
  return token;
}

/**
 * Rate-limits the two unauthenticated routes that run scrypt.
 *
 * docs/server-api.md lists this as something the reference server leaves to the
 * operator, to be supplied by a reverse proxy or WAF. The platform offers it
 * directly, so it is enforced here instead of being a deployment footnote. The
 * key is the client IP plus the route, so one abusive client cannot lock out
 * everyone else.
 */
async function rateLimit(env: Env, request: Request, scope: string): Promise<void> {
  if (env.AUTH_RATE_LIMITER === undefined) return;
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.AUTH_RATE_LIMITER.limit({ key: `${scope}:${ip}` });
  if (!success) throw new ApiError(429, "too many requests; retry later");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = readConfig(env);
    const cors = corsHeaders(request, config);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response: Response;
    try {
      response = await route(request, env, config);
    } catch (error) {
      if (error instanceof ApiError) {
        response = json({ error: error.message }, error.status);
      } else {
        // Every error reaching the client is a JSON object with an `error`
        // string, as the contract requires. The detail is logged rather than
        // returned, so internals are not disclosed.
        console.error("unhandled error", error);
        response = json({ error: "internal server error" }, 500);
      }
    }

    // Mutable copy: a Response built above is immutable once returned from a
    // helper, and the CORS headers have to join whatever the route already set.
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
