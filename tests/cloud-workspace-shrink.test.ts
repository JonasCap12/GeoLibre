import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature } from "geojson";
import type { TFunction } from "i18next";
import {
  CLOUD_WORKSPACE_INLINE_BYTES,
  createWorkspacePromotionBook,
  deleteSupersededUploads,
  documentBytes,
  shrinkWorkspaceLayers,
  workspaceTooLargeMessage,
} from "../apps/geolibre-desktop/src/lib/cloud-workspace-shrink";

function point(x: number, color?: string): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [x, 10] },
    properties: color ? { stroke: color } : {},
  };
}

/** A library drawing that painting has marked edited, as `feature-color.ts` does. */
function paintedDrawing(id: string, features: Feature[]): GeoLibreLayer {
  return {
    id,
    name: `${id}.dwg`,
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    style: {},
    geojson: { type: "FeatureCollection", features },
    metadata: { sharedDatasetId: "original", geometryEdited: true },
  } as unknown as GeoLibreLayer;
}

/** Prices layers the way the snapshot does: a library reference is its id, not its features. */
function measure(layers: GeoLibreLayer[]): number {
  return layers.reduce(
    (sum, layer) =>
      sum +
      (layer.metadata.geometryEdited === true
        ? JSON.stringify(layer.geojson).length
        : String(layer.metadata.sharedDatasetId).length),
    0,
  );
}

function uploader() {
  let next = 1;
  const uploads: string[] = [];
  const upload = async (candidate: { layerId: string }) => {
    uploads.push(candidate.layerId);
    return { id: `copy-${next++}` };
  };
  return { upload, uploads };
}

const t = ((key: string, params: Record<string, unknown>) =>
  `${key} ${JSON.stringify(params)}`) as unknown as TFunction;

describe("shrinkWorkspaceLayers", () => {
  it("moves the painted drawing to the library and keeps its id", async () => {
    const book = createWorkspacePromotionBook();
    const { upload, uploads } = uploader();
    const drawing = paintedDrawing("bridge", [point(1, "#1f7a47"), point(2)]);
    const result = await shrinkWorkspaceLayers({
      layers: [drawing],
      token: "token",
      book,
      measure,
      upload,
      limit: 20,
    });
    assert.deepEqual(uploads, ["bridge"]);
    assert.deepEqual(result.promotions, [
      { layerId: "bridge", datasetId: "copy-1", filename: "bridge.geojson" },
    ]);
    assert.deepEqual(result.superseded, []);
    assert.equal(result.failure, null);
    assert.equal(book.uploaded.get("bridge"), "copy-1");
  });

  it("supersedes this session's older copy when the drawing is painted again", async () => {
    const book = createWorkspacePromotionBook();
    const { upload, uploads } = uploader();
    const shrink = (features: Feature[]) =>
      shrinkWorkspaceLayers({
        layers: [paintedDrawing("bridge", features)],
        token: "token",
        book,
        measure,
        upload,
        limit: 20,
      });

    await shrink([point(1, "#1f7a47"), point(2)]);
    const second = await shrink([point(1, "#1f7a47"), point(2, "#1f7a47")]);
    assert.deepEqual(second.superseded, ["copy-1"]);
    assert.equal(book.uploaded.get("bridge"), "copy-2");

    // Undoing back to the first paint must upload again: copy-1 is being deleted.
    const third = await shrink([point(1, "#1f7a47"), point(2)]);
    assert.deepEqual(uploads, ["bridge", "bridge", "bridge"]);
    assert.deepEqual(third.superseded, ["copy-2"]);
    assert.equal(book.uploaded.get("bridge"), "copy-3");
  });

  it("reuses the copy of unchanged features instead of uploading twice", async () => {
    const book = createWorkspacePromotionBook();
    const { upload, uploads } = uploader();
    const features = [point(1, "#1f7a47"), point(2)];
    for (let i = 0; i < 2; i += 1) {
      const result = await shrinkWorkspaceLayers({
        layers: [paintedDrawing("bridge", features)],
        token: "token",
        book,
        measure,
        upload,
        limit: 20,
      });
      assert.deepEqual(result.superseded, []);
    }
    assert.deepEqual(uploads, ["bridge"]);
  });

  it("leaves a document that already fits alone", async () => {
    const book = createWorkspacePromotionBook();
    const { upload, uploads } = uploader();
    const result = await shrinkWorkspaceLayers({
      layers: [paintedDrawing("bridge", [point(1)])],
      token: "token",
      book,
      measure,
      upload,
    });
    assert.deepEqual(uploads, []);
    assert.deepEqual(result.promotions, []);
    assert.ok(result.bytes <= CLOUD_WORKSPACE_INLINE_BYTES);
  });

  it("reports a rejected upload so the save can say which layer failed", async () => {
    const result = await shrinkWorkspaceLayers({
      layers: [paintedDrawing("bridge", [point(1), point(2)])],
      token: "token",
      book: createWorkspacePromotionBook(),
      measure,
      upload: async () => {
        throw new Error("dataset exceeds the limit");
      },
      limit: 20,
    });
    assert.deepEqual(result.promotions, []);
    assert.deepEqual(result.failure, {
      layerName: "bridge.dwg",
      reason: "upload",
      detail: "dataset exceeds the limit",
    });
  });
});

describe("workspaceTooLargeMessage", () => {
  it("names the layer whose upload failed", () => {
    const message = workspaceTooLargeMessage(
      { failure: { layerName: "bridge.dwg", reason: "upload", detail: "HTTP 413" }, bytes: 1 },
      t,
    );
    assert.equal(
      message,
      'cloudWorkspace.layerUploadFailed {"name":"bridge.dwg","detail":"HTTP 413"}',
    );
  });

  it("falls back to the sizes in megabytes", () => {
    const message = workspaceTooLargeMessage({ failure: null, bytes: 22_673_594 }, t);
    // The limit shown is the API's, the one a refused save actually hit.
    assert.equal(message, 'cloudWorkspace.tooLarge {"size":"21.6","limit":"50.0"}');
  });
});

describe("deleteSupersededUploads", () => {
  it("keeps deleting after one copy fails", async () => {
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const deleted: string[] = [];
      await deleteSupersededUploads(["a", "b", "c"], async (id) => {
        if (id === "b") throw new Error("offline");
        deleted.push(id);
      });
      assert.deepEqual(deleted, ["a", "c"]);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      warn.mock.restore();
    }
  });
});

describe("documentBytes", () => {
  it("counts UTF-8 bytes, not UTF-16 units", () => {
    // "ầ" is U+1EA7, three bytes in UTF-8; the string is three UTF-16 units.
    assert.equal(documentBytes("Cầu"), 5);
  });
});

describe("autosave size warning", () => {
  it("warns once per stretch of oversized snapshots", async () => {
    const { addProjectSnapshot, MAX_SNAPSHOT_BYTES } =
      await import("../apps/geolibre-desktop/src/lib/project-history-store");
    const big = "x".repeat(MAX_SNAPSHOT_BYTES + 1);
    const warn = mock.method(console, "warn", () => undefined);
    const hadIndexedDb = "indexedDB" in globalThis;
    // The size check runs before the database is opened; only its presence matters.
    Object.assign(globalThis, { indexedDB: {} });
    try {
      assert.equal(await addProjectSnapshot(big), "too-large");
      assert.equal(await addProjectSnapshot(big), "too-large");
      assert.equal(warn.mock.callCount(), 1);
      // A snapshot that fits ends the stretch, even if storing it then fails here.
      await assert.rejects(addProjectSnapshot('{"version":1}'));
      assert.equal(await addProjectSnapshot(big), "too-large");
      assert.equal(warn.mock.callCount(), 2);
    } finally {
      warn.mock.restore();
      if (!hadIndexedDb) delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });
});

describe("currentPromotions", () => {
  it("drops a promotion for a layer painted again while it uploaded", async () => {
    const { currentPromotions } =
      await import("../apps/geolibre-desktop/src/lib/cloud-workspace-shrink");
    const a = paintedDrawing("a", [point(1)]);
    const b = paintedDrawing("b", [point(2)]);
    const repainted = { ...b, geojson: { type: "FeatureCollection", features: [point(2, "red")] } };
    const promotions = [
      { layerId: "a", datasetId: "copy-1", filename: "a.geojson" },
      { layerId: "b", datasetId: "copy-2", filename: "b.geojson" },
      { layerId: "gone", datasetId: "copy-3", filename: "gone.geojson" },
    ];
    assert.deepEqual(
      currentPromotions(promotions, [a, b], [a, repainted as GeoLibreLayer]).map((p) => p.layerId),
      ["a"],
    );
  });
});

describe("cloudSaveRetryDelay", () => {
  it("backs off on network errors, 429 and 5xx, then stops", async () => {
    const { cloudSaveRetryDelay, CLOUD_SAVE_RETRY_DELAYS_MS } =
      await import("../apps/geolibre-desktop/src/lib/cloud-workspace-shrink");
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((attempt) => cloudSaveRetryDelay(undefined, attempt)),
      [...CLOUD_SAVE_RETRY_DELAYS_MS, null],
    );
    assert.equal(cloudSaveRetryDelay(429, 0), 15_000);
    assert.equal(cloudSaveRetryDelay(503, 1), 60_000);
  });

  it("does not retry what the same document would fail again", async () => {
    const { cloudSaveRetryDelay } =
      await import("../apps/geolibre-desktop/src/lib/cloud-workspace-shrink");
    for (const status of [400, 401, 403, 404, 413, 422])
      assert.equal(cloudSaveRetryDelay(status, 0), null);
  });
});
