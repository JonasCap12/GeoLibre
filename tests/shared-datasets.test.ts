import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deleteSharedDataset,
  fetchSharedDatasetBytes,
  formatDatasetSize,
  listSharedDatasets,
  type SharedDataset,
  SharedDatasetError,
  uploadSharedDataset,
} from "../apps/geolibre-desktop/src/lib/shared-datasets.ts";

const BASE = "https://api.example.test";

/** A recorded call, so a test can assert on what went over the wire. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch stand-in that records calls and replays a queued response.
 *
 * The real client is wired to `getShareFetch()`, which in the desktop build
 * routes through Tauri; every function takes a `fetchImpl` override for exactly
 * this reason.
 */
function stubFetch(responses: Response[]): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    const next = queue.shift();
    if (!next) throw new Error("no queued response");
    return next;
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const DATASET: SharedDataset = {
  id: "abc",
  name: "Tim tuyen BL-LK",
  description: "",
  filename: "tim-tuyen.geojson",
  contentType: "application/geo+json",
  sizeBytes: 1_900_000,
  visibility: "public",
  downloads: 3,
  owner: "nhut",
  createdAt: "2026-09-22T00:00:00Z",
  updatedAt: "2026-09-22T00:00:00Z",
  contentUrl: `${BASE}/api/datasets/abc/content`,
};

describe("listSharedDatasets", () => {
  it("reads the library without a token", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ datasets: [DATASET] })]);
    const result = await listSharedDatasets({ baseUrl: BASE, fetchImpl: fetch });
    assert.deepEqual(result, [DATASET]);
    assert.equal(calls[0].url, `${BASE}/api/datasets`);
    // Anonymous reads must not invent an Authorization header, or a deployment
    // that allows public reads would reject them as a malformed credential.
    assert.equal(calls[0].headers.Authorization, undefined);
  });

  it("sends the token when one is configured", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ datasets: [] })]);
    await listSharedDatasets({ baseUrl: BASE, fetchImpl: fetch, token: "  secret  " });
    assert.equal(calls[0].headers.Authorization, "Bearer secret");
  });

  it("tolerates a response with no datasets key", async () => {
    const { fetch } = stubFetch([jsonResponse({})]);
    assert.deepEqual(await listSharedDatasets({ baseUrl: BASE, fetchImpl: fetch }), []);
  });

  it("reports the server's own reason", async () => {
    const { fetch } = stubFetch([jsonResponse({ detail: "library is closed" }, 503)]);
    await assert.rejects(
      listSharedDatasets({ baseUrl: BASE, fetchImpl: fetch }),
      (error: SharedDatasetError) => {
        assert.equal(error.message, "library is closed");
        assert.equal(error.status, 503);
        return true;
      },
    );
  });

  it("explains a rejected token rather than echoing the status", async () => {
    const { fetch } = stubFetch([jsonResponse({ detail: "invalid token" }, 401)]);
    await assert.rejects(
      listSharedDatasets({ baseUrl: BASE, fetchImpl: fetch, token: "bad" }),
      /token was rejected/,
    );
  });

  it("survives a non-JSON error body", async () => {
    // A proxy in front of the API returns HTML; the status is all there is.
    const { fetch } = stubFetch([new Response("<html>502</html>", { status: 502 })]);
    await assert.rejects(listSharedDatasets({ baseUrl: BASE, fetchImpl: fetch }), /502/);
  });
});

describe("uploadSharedDataset", () => {
  it("puts the bytes in the body and the metadata in the query", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ dataset: DATASET }, 201)]);
    await uploadSharedDataset({
      baseUrl: BASE,
      fetchImpl: fetch,
      token: "secret",
      data: new Uint8Array([1, 2, 3]),
      filename: "drawing.dxf",
      name: "Ban ve",
      visibility: "private",
      contentType: "image/vnd.dxf",
    });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/datasets");
    assert.equal(url.searchParams.get("filename"), "drawing.dxf");
    assert.equal(url.searchParams.get("name"), "Ban ve");
    assert.equal(url.searchParams.get("visibility"), "private");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Content-Type"], "image/vnd.dxf");
    assert.ok(calls[0].body instanceof ArrayBuffer);
    assert.equal((calls[0].body as ArrayBuffer).byteLength, 3);
  });

  it("sends only the view's bytes, not its whole backing buffer", async () => {
    // A Uint8Array read out of a larger buffer (a file slice, a worker
    // transfer) would otherwise upload everything behind it.
    const backing = new Uint8Array(1000);
    const view = backing.subarray(10, 20);
    const { fetch, calls } = stubFetch([jsonResponse({ dataset: DATASET }, 201)]);
    await uploadSharedDataset({
      baseUrl: BASE,
      fetchImpl: fetch,
      token: "secret",
      data: view,
      filename: "x.bin",
    });
    assert.equal((calls[0].body as ArrayBuffer).byteLength, 10);
  });

  it("omits blank optional metadata", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ dataset: DATASET }, 201)]);
    await uploadSharedDataset({
      baseUrl: BASE,
      fetchImpl: fetch,
      token: "secret",
      data: new Uint8Array([0]),
      filename: "x.bin",
      name: "   ",
      description: "",
    });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("name"), null);
    assert.equal(url.searchParams.get("description"), null);
  });

  it("refuses to upload without a token instead of calling the server", async () => {
    const { fetch, calls } = stubFetch([]);
    await assert.rejects(
      uploadSharedDataset({
        baseUrl: BASE,
        fetchImpl: fetch,
        token: "   ",
        data: new Uint8Array([0]),
        filename: "x.bin",
      }),
      /token in Settings/,
    );
    assert.equal(calls.length, 0);
  });

  it("turns an over-size rejection into the server's explanation", async () => {
    const { fetch } = stubFetch([jsonResponse({ detail: "dataset exceeds the limit" }, 413)]);
    await assert.rejects(
      uploadSharedDataset({
        baseUrl: BASE,
        fetchImpl: fetch,
        token: "secret",
        data: new Uint8Array([0]),
        filename: "x.bin",
      }),
      /exceeds the limit/,
    );
  });

  it("fails when the server returns no dataset", async () => {
    const { fetch } = stubFetch([jsonResponse({}, 201)]);
    await assert.rejects(
      uploadSharedDataset({
        baseUrl: BASE,
        fetchImpl: fetch,
        token: "secret",
        data: new Uint8Array([0]),
        filename: "x.bin",
      }),
      /returned no dataset/,
    );
  });
});

describe("fetchSharedDatasetBytes", () => {
  it("returns the raw bytes", async () => {
    const { fetch, calls } = stubFetch([new Response(new Uint8Array([7, 8, 9]))]);
    const bytes = await fetchSharedDatasetBytes("abc", { baseUrl: BASE, fetchImpl: fetch });
    assert.deepEqual([...bytes], [7, 8, 9]);
    assert.equal(calls[0].url, `${BASE}/api/datasets/abc/content`);
  });

  it("percent-encodes the id", async () => {
    const { fetch, calls } = stubFetch([new Response(new Uint8Array())]);
    await fetchSharedDatasetBytes("a/b", { baseUrl: BASE, fetchImpl: fetch });
    assert.equal(calls[0].url, `${BASE}/api/datasets/a%2Fb/content`);
  });
});

describe("deleteSharedDataset", () => {
  it("sends DELETE with the token", async () => {
    const { fetch, calls } = stubFetch([new Response(null, { status: 204 })]);
    await deleteSharedDataset("abc", { baseUrl: BASE, fetchImpl: fetch, token: "secret" });
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].headers.Authorization, "Bearer secret");
  });

  it("treats an already-deleted dataset as success", async () => {
    // Two people deleting the same row should not leave one staring at an error.
    const { fetch } = stubFetch([jsonResponse({ detail: "dataset not found" }, 404)]);
    await deleteSharedDataset("abc", { baseUrl: BASE, fetchImpl: fetch, token: "secret" });
  });

  it("still reports a refusal", async () => {
    const { fetch } = stubFetch([jsonResponse({ detail: "dataset ownership required" }, 403)]);
    await assert.rejects(
      deleteSharedDataset("abc", { baseUrl: BASE, fetchImpl: fetch, token: "secret" }),
      /ownership required/,
    );
  });
});

describe("formatDatasetSize", () => {
  it("keeps bytes below a kilobyte", () => {
    assert.equal(formatDatasetSize(512), "512 B");
  });

  it("uses one decimal while the number is small", () => {
    assert.equal(formatDatasetSize(1536), "1.5 KB");
  });

  it("drops the decimal once it is not informative", () => {
    assert.equal(formatDatasetSize(45.5 * 1024 * 1024), "46 MB");
  });

  it("stops at gigabytes", () => {
    assert.equal(formatDatasetSize(5 * 1024 ** 3), "5.0 GB");
  });
});
