// Row shapes, serialization, visibility rules, and the activity log.
//
// The JSON shapes here are the contract in docs/server-api.md, not an artifact
// of this implementation: camelCase keys, ISO 8601 UTC timestamps, and absolute
// rawJsonUrl/projectUrl/viewerUrl (thumbnailUrl stays root-relative, which the
// document explicitly allows).

export type Visibility = "public" | "unlisted" | "private";

export interface Config {
  baseUrl: string;
  viewerUrl: string;
  maxProjectBytes: number;
  maxThumbnailBytes: number;
  activityRetentionDays: number;
  corsOrigins: string[];
}

export interface AccountRow {
  id: string;
  username: string | null;
  password_hash: string;
  created_at: string;
}

/** A project joined with its owner's username and its version count. */
export interface ProjectRow {
  id: string;
  owner_id: string;
  slug: string;
  title: string;
  description: string;
  visibility: string;
  tags_json: string;
  thumbnail_type: string | null;
  views: number;
  fork_count: number;
  featured: number;
  created_at: string;
  updated_at: string;
  owner_username: string | null;
  version_count: number;
}

export interface ActivityRow {
  id: string;
  action: string;
  actor_id: string | null;
  details_json: string;
  bucket_key: string | null;
  count: number;
  created_at: string;
}

/**
 * Every project read goes through this projection so owner_username and
 * version_count are always present. The reference implementation eager-loads
 * both for the same reason: derived per row, a 100-row listing became ~201
 * queries.
 */
export const PROJECT_SELECT = `
  SELECT p.*, a.username AS owner_username,
         (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS version_count
  FROM projects p JOIN accounts a ON a.id = p.owner_id`;

/** ISO 8601 UTC, the format the API returns verbatim and orders listings by. */
export const now = (): string => new Date().toISOString();

export function accountJson(account: AccountRow): Record<string, unknown> {
  return { id: account.id, username: account.username, createdAt: account.created_at };
}

export function projectJson(project: ProjectRow, config: Config): Record<string, unknown> {
  const username = project.owner_username ?? "";
  const raw = `${config.baseUrl}/${encodeURIComponent(username)}/${encodeURIComponent(project.slug)}.geolibre.json`;
  const page = `${config.baseUrl}/${encodeURIComponent(username)}/${encodeURIComponent(project.slug)}`;
  let tags: unknown;
  try {
    tags = JSON.parse(project.tags_json);
  } catch {
    tags = [];
  }
  return {
    id: project.id,
    username,
    slug: project.slug,
    title: project.title,
    description: project.description,
    thumbnailUrl: project.thumbnail_type ? `/api/projects/${project.id}/thumbnail` : null,
    visibility: project.visibility,
    views: project.views,
    forkCount: project.fork_count,
    versionCount: project.version_count,
    featured: project.featured !== 0,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    tags: Array.isArray(tags) ? tags : [],
    rawJsonUrl: raw,
    projectUrl: page,
    // config.viewerUrl already carries its single trailing slash, matching the
    // reference, so this yields https://host/?project=… and not https://host?project=…
    viewerUrl: `${config.viewerUrl}?project=${encodeURIComponent(raw)}`,
  };
}

export function activityJson(row: ActivityRow): Record<string, unknown> {
  let details: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.details_json);
    details = parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    details = {};
  }
  // The count belongs to aggregated rows only; a per-event row has no count to
  // report and the contract's example omits it.
  if (row.bucket_key !== null) details.count = row.count;
  return {
    id: row.id,
    action: row.action,
    actorId: row.actor_id,
    details,
    createdAt: row.created_at,
  };
}

/** Actions an anonymous visitor can trigger, which are counted and never stored per hit. */
const AGGREGATED_ANONYMOUS_ACTIONS = new Set(["open", "fetch"]);

/**
 * Records a project event, aggregating anonymous opens and fetches into one row
 * per project, action and UTC day.
 *
 * The aggregation is what keeps the log from becoming a visitor record: the
 * owner learns "opened 40 times on 2026-08-21" and nothing about who did it, and
 * no IP address or other fingerprint is stored. A single INSERT ... ON CONFLICT
 * does the counting, so concurrent hits cannot lose each other's increment --
 * the reference needs an UPDATE-then-INSERT-then-retry dance for the same
 * guarantee because SQLAlchemy cannot express the upsert portably.
 *
 * Batched with the retention prune so a request either records its event and
 * trims the log or does neither.
 */
export function activityStatements(
  db: D1Database,
  config: Config,
  projectId: string,
  actorId: string | null,
  action: string,
  details: Record<string, unknown> = {},
): D1PreparedStatement[] {
  const timestamp = now();
  const cutoff = new Date(
    Date.now() - config.activityRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  let bucketKey: string | null = null;
  let payload = details;
  if (actorId === null && AGGREGATED_ANONYMOUS_ACTIONS.has(action)) {
    const day = timestamp.slice(0, 10);
    bucketKey = `${projectId}:${action}:${day}`;
    payload = { date: day };
  }

  return [
    db
      .prepare(`DELETE FROM project_activities WHERE project_id = ? AND created_at < ?`)
      .bind(projectId, cutoff),
    db
      .prepare(
        `INSERT INTO project_activities
           (id, project_id, actor_id, action, details_json, bucket_key, count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1`,
      )
      .bind(
        crypto.randomUUID(),
        projectId,
        actorId,
        action,
        JSON.stringify(payload),
        bucketKey,
        timestamp,
      ),
  ];
}

/** 3-39 chars, starting and ending alphanumeric. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,37}[a-z0-9]$/;

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return slug || "project";
}

export function titleFrom(document: Record<string, unknown>, filename: string): string {
  const declared = document.title;
  let candidate: string;
  if (typeof declared === "string" && declared.trim() !== "") {
    candidate = declared;
  } else {
    // Both suffixes are stripped in sequence, not as alternatives, matching the
    // reference's chained removesuffix: "Map.geolibre.json" loses the long one
    // and "Map.json" the short one.
    let name = filename.split(/[\\/]/).pop() ?? filename;
    if (name.endsWith(".geolibre.json")) name = name.slice(0, -".geolibre.json".length);
    if (name.endsWith(".json")) name = name.slice(0, -".json".length);
    candidate = name;
  }
  candidate = candidate.trim();
  // Unicode code points, not UTF-16 units, so an emoji-laden title is measured
  // the way the limits table in docs/server-api.md states.
  if ([...candidate].length > 100) {
    throw new ApiError(422, "project title must not exceed 100 characters");
  }
  return candidate || "Untitled";
}

/** An error carrying the HTTP status and the `error` string the contract specifies. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseContent(content: string, maxBytes: number): Record<string, unknown> {
  if (new TextEncoder().encode(content).length > maxBytes) {
    throw new ApiError(413, `project document exceeds the ${maxBytes} byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ApiError(422, `content must be valid JSON: ${(error as Error).message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "content must contain a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * 404 for both a missing project and one the caller may not discover, so a
 * status code never reveals that a private project exists.
 */
export function visible(project: ProjectRow | null, accountId: string | null): ProjectRow {
  if (
    project === null ||
    (project.visibility === "private" && (accountId === null || project.owner_id !== accountId))
  ) {
    throw new ApiError(404, "project not found");
  }
  return project;
}

export function owned(project: ProjectRow | null, accountId: string): ProjectRow {
  if (project === null) throw new ApiError(404, "project not found");
  if (project.owner_id !== accountId) throw new ApiError(403, "project ownership required");
  return project;
}
