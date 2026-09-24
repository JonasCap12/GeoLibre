import { getShareFetch } from "./share-fetch";

/** Private project used as the browser app's durable, account-scoped workspace. */
export const CLOUD_WORKSPACE_TITLE = "GeoLibre Web Workspace";
export const CLOUD_WORKSPACE_TAG = "geolibre-web-workspace";

export interface CloudWorkspaceProject {
  id: string;
  rawJsonUrl: string;
  title: string;
  tags: string[];
  updatedAt: string;
}

export interface CloudWorkspaceOptions {
  token: string;
  baseUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export class CloudWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CloudWorkspaceError";
  }
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function requestHeaders(token: string, jsonBody = false): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...(jsonBody ? { "Content-Type": "application/json" } : {}),
  };
}

async function responseError(response: Response, fallback: string): Promise<CloudWorkspaceError> {
  let message = "";
  try {
    const body = (await response.json()) as { error?: unknown; detail?: unknown };
    const detail = body.error ?? body.detail;
    if (typeof detail === "string") message = detail;
  } catch {
    // Proxies can return HTML/text errors. The status still makes the failure actionable.
  }
  return new CloudWorkspaceError(message || `${fallback} (HTTP ${response.status})`, response.status);
}

function parseProject(value: unknown): CloudWorkspaceProject | null {
  if (!value || typeof value !== "object") return null;
  const project = value as Record<string, unknown>;
  if (
    typeof project.id !== "string" ||
    typeof project.rawJsonUrl !== "string" ||
    typeof project.title !== "string"
  ) {
    return null;
  }
  return {
    id: project.id,
    rawJsonUrl: project.rawJsonUrl,
    title: project.title,
    tags: Array.isArray(project.tags)
      ? project.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : "",
  };
}

function projectFromEnvelope(value: unknown): CloudWorkspaceProject {
  const envelope = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const project = parseProject(envelope?.project);
  if (!project) throw new CloudWorkspaceError("The projects server returned an invalid project.");
  return project;
}

async function fetchResponse(
  url: string,
  init: RequestInit,
  fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new CloudWorkspaceError("Could not reach the projects server.");
  }
}

/** Find the newest private workspace project owned by the current token. */
export async function findCloudWorkspace(
  options: CloudWorkspaceOptions,
): Promise<CloudWorkspaceProject | null> {
  const base = normalizedBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  const response = await fetchResponse(
    `${base}/api/projects?mine=true&limit=100`,
    {
      headers: requestHeaders(options.token),
      cache: "no-store",
      signal: options.signal,
    },
    fetchImpl,
  );
  if (!response.ok) throw await responseError(response, "Could not find the cloud workspace");

  const body = (await response.json()) as { projects?: unknown };
  const projects = Array.isArray(body.projects)
    ? body.projects.map(parseProject).filter((project): project is CloudWorkspaceProject => !!project)
    : [];
  // The tag is the durable marker. The reserved title is a recovery path for
  // the narrow case where POST succeeded but the follow-up marker PATCH did not.
  return (
    projects.find((project) => project.tags.includes(CLOUD_WORKSPACE_TAG)) ??
    projects.find((project) => project.title === CLOUD_WORKSPACE_TITLE) ??
    null
  );
}

/** Download a private workspace without ever forwarding its token cross-origin. */
export async function downloadCloudWorkspace(
  project: CloudWorkspaceProject,
  options: CloudWorkspaceOptions,
): Promise<string> {
  const base = normalizedBaseUrl(options.baseUrl);
  let rawUrl: URL;
  try {
    rawUrl = new URL(project.rawJsonUrl, `${base}/`);
  } catch {
    throw new CloudWorkspaceError("The projects server returned an invalid workspace URL.");
  }
  if (rawUrl.origin !== new URL(base).origin) {
    throw new CloudWorkspaceError("The projects server returned a workspace URL on another host.");
  }

  const fetchImpl = options.fetchImpl ?? getShareFetch();
  const response = await fetchResponse(
    rawUrl.href,
    {
      headers: requestHeaders(options.token),
      cache: "no-store",
      signal: options.signal,
    },
    fetchImpl,
  );
  if (!response.ok) throw await responseError(response, "Could not download the cloud workspace");
  return response.text();
}

/** Create the private workspace project and mark it so another browser can find it. */
export async function createCloudWorkspace(
  content: string,
  options: CloudWorkspaceOptions,
): Promise<CloudWorkspaceProject> {
  const base = normalizedBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  const createdResponse = await fetchResponse(
    `${base}/api/projects`,
    {
      method: "POST",
      headers: requestHeaders(options.token, true),
      body: JSON.stringify({
        content,
        filename: `${CLOUD_WORKSPACE_TITLE}.geolibre.json`,
        visibility: "private",
      }),
      signal: options.signal,
    },
    fetchImpl,
  );
  if (!createdResponse.ok) {
    throw await responseError(createdResponse, "Could not create the cloud workspace");
  }
  const project = projectFromEnvelope(await createdResponse.json());

  // Keep the reserved title as a fallback marker even if this request fails:
  // the next launch can recover the already-uploaded project instead of
  // creating a duplicate. A later save retries the marker through this client.
  let markerResponse: Response;
  try {
    markerResponse = await fetchResponse(
      `${base}/api/projects/${encodeURIComponent(project.id)}`,
      {
        method: "PATCH",
        headers: requestHeaders(options.token, true),
        body: JSON.stringify({ tags: [CLOUD_WORKSPACE_TAG] }),
        signal: options.signal,
      },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return project;
  }
  if (!markerResponse.ok) {
    // The content is already durable. Returning it is safer than treating the
    // whole save as failed and posting a duplicate on the next edit.
    return project;
  }
  return projectFromEnvelope(await markerResponse.json());
}

/** Append a new immutable server version to an existing private workspace. */
export async function updateCloudWorkspace(
  projectId: string,
  content: string,
  options: CloudWorkspaceOptions,
): Promise<CloudWorkspaceProject> {
  const base = normalizedBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  const response = await fetchResponse(
    `${base}/api/projects/${encodeURIComponent(projectId)}/content`,
    {
      method: "PUT",
      headers: requestHeaders(options.token, true),
      body: JSON.stringify({ content }),
      signal: options.signal,
    },
    fetchImpl,
  );
  if (!response.ok) throw await responseError(response, "Could not save the cloud workspace");
  return projectFromEnvelope(await response.json());
}
