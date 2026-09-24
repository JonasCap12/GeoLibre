import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLOUD_WORKSPACE_TAG,
  CLOUD_WORKSPACE_TITLE,
  CloudWorkspaceError,
  createCloudWorkspace,
  downloadCloudWorkspace,
  findCloudWorkspace,
  updateCloudWorkspace,
} from "../apps/geolibre-desktop/src/lib/cloud-workspace";

const BASE = "https://projects.example.test";
const TOKEN = "secret-token";

interface Call {
  url: string;
  init: RequestInit;
  body: unknown;
}

function stubFetch(
  handler: (call: Call, index: number) => { status?: number; body?: unknown; text?: string },
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rawBody = init.body ? String(init.body) : "";
    const call: Call = {
      url: String(input),
      init,
      body: rawBody ? JSON.parse(rawBody) : null,
    };
    calls.push(call);
    const result = handler(call, calls.length - 1);
    return new Response(result.text ?? JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function apiProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace-id",
    rawJsonUrl: `${BASE}/alice/geolibre-web-workspace.geolibre.json`,
    title: CLOUD_WORKSPACE_TITLE,
    tags: [CLOUD_WORKSPACE_TAG],
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("cloud workspace discovery", () => {
  it("finds the tagged workspace with the bearer token", async () => {
    const { fetch, calls } = stubFetch(() => ({
      body: { projects: [apiProject()] },
    }));
    const project = await findCloudWorkspace({ token: TOKEN, baseUrl: `${BASE}/`, fetchImpl: fetch });
    assert.equal(project?.id, "workspace-id");
    assert.equal(calls[0].url, `${BASE}/api/projects?mine=true&limit=100`);
    assert.equal(new Headers(calls[0].init.headers).get("Authorization"), `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.cache, "no-store");
  });

  it("recovers a create whose marker PATCH failed by its reserved title", async () => {
    const { fetch } = stubFetch(() => ({
      body: { projects: [apiProject({ tags: [] })] },
    }));
    const project = await findCloudWorkspace({ token: TOKEN, baseUrl: BASE, fetchImpl: fetch });
    assert.equal(project?.id, "workspace-id");
  });

  it("returns null when the account has no cloud workspace", async () => {
    const { fetch } = stubFetch(() => ({ body: { projects: [] } }));
    assert.equal(
      await findCloudWorkspace({ token: TOKEN, baseUrl: BASE, fetchImpl: fetch }),
      null,
    );
  });

  it("surfaces an invalid token without leaking it", async () => {
    const { fetch } = stubFetch(() => ({ status: 401, body: { error: "invalid token" } }));
    await assert.rejects(
      () => findCloudWorkspace({ token: TOKEN, baseUrl: BASE, fetchImpl: fetch }),
      (error: Error) => {
        assert.ok(error instanceof CloudWorkspaceError);
        assert.equal((error as CloudWorkspaceError).status, 401);
        assert.match(error.message, /invalid token/);
        assert.ok(!error.message.includes(TOKEN));
        return true;
      },
    );
  });
});

describe("cloud workspace content", () => {
  it("downloads private content with auth and no cache", async () => {
    const content = '{"version":"1","name":"Map"}';
    const { fetch, calls } = stubFetch(() => ({ text: content }));
    assert.equal(
      await downloadCloudWorkspace(apiProject(), {
        token: TOKEN,
        baseUrl: BASE,
        fetchImpl: fetch,
      }),
      content,
    );
    assert.equal(new Headers(calls[0].init.headers).get("Authorization"), `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.cache, "no-store");
  });

  it("never sends the bearer token to a raw URL on another origin", async () => {
    const { fetch, calls } = stubFetch(() => ({ text: "{}" }));
    await assert.rejects(
      () =>
        downloadCloudWorkspace(apiProject({ rawJsonUrl: "https://evil.example/workspace.json" }), {
          token: TOKEN,
          baseUrl: BASE,
          fetchImpl: fetch,
        }),
      /another host/,
    );
    assert.equal(calls.length, 0);
  });

  it("creates a private project and marks it for cross-browser discovery", async () => {
    const { fetch, calls } = stubFetch((_call, index) => ({
      status: index === 0 ? 201 : 200,
      body: { project: apiProject(index === 0 ? { tags: [] } : {}) },
    }));
    const project = await createCloudWorkspace('{"name":"My map"}', {
      token: TOKEN,
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(project.id, "workspace-id");
    assert.deepEqual(calls[0].body, {
      content: '{"name":"My map"}',
      filename: `${CLOUD_WORKSPACE_TITLE}.geolibre.json`,
      visibility: "private",
    });
    assert.equal(calls[1].init.method, "PATCH");
    assert.deepEqual(calls[1].body, { tags: [CLOUD_WORKSPACE_TAG] });
  });

  it("keeps a successfully created project when only its marker PATCH fails", async () => {
    const { fetch } = stubFetch((_call, index) =>
      index === 0
        ? { status: 201, body: { project: apiProject({ tags: [] }) } }
        : { status: 503, body: { error: "temporary" } },
    );
    const project = await createCloudWorkspace("{}", {
      token: TOKEN,
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(project.id, "workspace-id");
  });

  it("keeps a successfully created project when the marker request loses the network", async () => {
    let request = 0;
    const fetchImpl = (async () => {
      request += 1;
      if (request === 2) throw new TypeError("network lost");
      return new Response(JSON.stringify({ project: apiProject({ tags: [] }) }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const project = await createCloudWorkspace("{}", {
      token: TOKEN,
      baseUrl: BASE,
      fetchImpl,
    });
    assert.equal(project.id, "workspace-id");
    assert.equal(request, 2);
  });

  it("appends a version when the workspace already exists", async () => {
    const { fetch, calls } = stubFetch(() => ({
      status: 201,
      body: { project: apiProject(), version: 2 },
    }));
    await updateCloudWorkspace("workspace/id", "{\"layers\":[]}", {
      token: TOKEN,
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(calls[0].url, `${BASE}/api/projects/workspace%2Fid/content`);
    assert.equal(calls[0].init.method, "PUT");
    assert.deepEqual(calls[0].body, { content: '{"layers":[]}' });
  });
});
