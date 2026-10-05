import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { MAX_SNAPSHOT_BYTES } from "../packages/collab-core/src/session.ts";
import { prepareCollaborationLayers } from "../apps/geolibre-desktop/src/lib/collaboration-layers.ts";
import {
  CLIENT_SNAPSHOT_LIMIT_FALLBACK,
  learnedSnapshotLimit,
  snapshotSyncAction,
  snapshotSyncLimit,
} from "../apps/geolibre-desktop/src/lib/collaboration-sync.ts";
import {
  classifySharedDatasetError,
  markSharedLayerFailure,
  resolveSharedDatasetFilename,
  sharedLayerFailureOf,
} from "../apps/geolibre-desktop/src/lib/collaboration-shared-layer.ts";
import { SharedDatasetError } from "../apps/geolibre-desktop/src/lib/shared-datasets.ts";
import {
  createSharedRehydrateSession,
  rehydrateSharedLayers,
} from "../apps/geolibre-desktop/src/lib/collaboration-shared-rehydrate.ts";
import { geojsonLayer } from "./helpers/layer-fixtures.ts";

/**
 * A survey drawing is 30–40 MB of GeoJSON. Live sync holds 10 MB, and one
 * rejection used to stop the session until everyone left and rejoined — with
 * the explanation written somewhere the user was not looking. Library-backed
 * layers do not need to travel through the relay at all: the bytes are already
 * on the team's server, so the snapshot only has to carry the id.
 */

const FEATURES = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { name: "road" },
      geometry: { type: "Point" as const, coordinates: [1, 2] },
    },
  ],
};

describe("snapshot sync pause", () => {
  it("stays paused while the project is still over the limit", () => {
    // Sending again would put a 41 MB payload on the wire on every keystroke.
    const learned = 10_000_000;
    assert.equal(snapshotSyncAction(41_000_000, learned), "hold");
  });

  it("resumes once the project is back under the limit", () => {
    assert.equal(snapshotSyncAction(1_500_000, 10_000_000), "send");
  });

  it("prefers a limit learned from a rejection over the compile-time ceiling", () => {
    // Before any rejection the only number we have is the constant. After one,
    // the relay's own ceiling (it may be lower) is what the next edit is measured against.
    assert.equal(CLIENT_SNAPSHOT_LIMIT_FALLBACK, MAX_SNAPSHOT_BYTES);
    assert.equal(snapshotSyncLimit(null), MAX_SNAPSHOT_BYTES);
    const learned = learnedSnapshotLimit(
      "Project is 12.0 MB; live sync holds 2.0 MB. Load fewer layers.",
    );
    assert.ok(learned !== null && learned <= 2_000_000);
    assert.equal(snapshotSyncAction(3_000_000, learned), "hold");
    assert.equal(snapshotSyncAction(3_000_000, null), "send");
  });

  it("does not learn a ceiling above the real one when the relay rounds", () => {
    // 8,388,608 (8 MiB) prints as 8.4 MB. Rounding that back up is 8,400,000,
    // which the relay would reject again.
    const learned = learnedSnapshotLimit("Project is 12.0 MB; live sync holds 8.4 MB.");
    assert.ok(learned !== null && learned <= 8_388_608, `learned ${learned}`);
  });
});

describe("shared-library collaboration snapshots", () => {
  it("omits embedded GeoJSON for a library layer and keeps the id", () => {
    const layer = geojsonLayer({
      metadata: {
        sharedDatasetId: "dataset-1",
        embeddedGeoJSON: FEATURES,
        localFileReloadable: true,
      },
      geojson: FEATURES,
    });
    const [portable] = prepareCollaborationLayers([layer], new Map([[layer.id, FEATURES]]));
    assert.equal(portable.metadata.sharedDatasetId, "dataset-1");
    assert.equal(portable.metadata.embeddedGeoJSON, undefined);
    assert.equal(portable.metadata.localFileReloadable, undefined);
    assert.equal(portable.geojson, undefined);
  });

  it("embeds an edited library layer and drops the id", () => {
    // The id means "fetch the server copy". Leaving it on an edited layer
    // makes peers replace the edit with the pristine dataset.
    const edited = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: { edited: true },
          geometry: { type: "Point" as const, coordinates: [9, 9] },
        },
      ],
    };
    const layer = geojsonLayer({
      geojson: edited,
      metadata: { sharedDatasetId: "dataset-1", geometryEdited: true },
    });
    const [portable] = prepareCollaborationLayers([layer], new Map());
    assert.equal(portable.geojson, edited);
    assert.equal(portable.metadata.sharedDatasetId, undefined);
    assert.equal(portable.metadata.geometryEdited, undefined);
  });

  it("still embeds a local-file layer", () => {
    const layer = geojsonLayer({
      id: "local",
      geojson: undefined,
      metadata: {
        externalNativeLayer: true,
        sourceKind: "maplibre-gl-vector",
        localFileReloadable: true,
      },
    });
    const [portable] = prepareCollaborationLayers([layer], new Map([["local", FEATURES]]));
    assert.equal(portable.metadata.embeddedGeoJSON, FEATURES);
    assert.equal(portable.metadata.sharedDatasetId, undefined);
  });

  it("keeps a library-only snapshot far smaller than the same drawing embedded", () => {
    const drawing = "x".repeat(2_000_000);
    // GeoJSON permits a null geometry; @types/geojson's `Feature` does not model
    // one. This comparison only needs a feature whose properties are large, so
    // the cast says what the fixture is rather than inventing a geometry.
    const heavy = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: { drawing },
          geometry: null,
        },
      ],
    } as unknown as FeatureCollection;
    const embedded = geojsonLayer({
      geojson: heavy,
      metadata: { embeddedGeoJSON: heavy },
    });
    const referenced = geojsonLayer({
      geojson: heavy,
      metadata: { sharedDatasetId: "dataset-1", embeddedGeoJSON: heavy },
    });
    const embeddedBytes = new TextEncoder().encode(
      JSON.stringify(prepareCollaborationLayers([embedded], new Map())),
    ).length;
    const referencedBytes = new TextEncoder().encode(
      JSON.stringify(prepareCollaborationLayers([referenced], new Map())),
    ).length;
    assert.ok(embeddedBytes > 2_000_000, `embedded was ${embeddedBytes}`);
    assert.ok(referencedBytes < 5_000, `referenced was ${referencedBytes}`);
    assert.ok(embeddedBytes / referencedBytes > 100);
  });
});

describe("shared layer load failures", () => {
  const layer = geojsonLayer({ metadata: { sharedDatasetId: "dataset-1" }, geojson: undefined });

  it("marks a missing token as sign-in, not an empty layer", () => {
    const failure = classifySharedDatasetError(
      new SharedDatasetError("dataset not found", 404),
      false,
    );
    const marked = markSharedLayerFailure(layer, failure);
    assert.equal(sharedLayerFailureOf(marked), "needs-sign-in");
    assert.equal(marked.geojson, undefined);
  });

  it("marks a deleted dataset as missing when the caller is signed in", () => {
    const failure = classifySharedDatasetError(
      new SharedDatasetError("dataset not found", 404),
      true,
    );
    assert.equal(sharedLayerFailureOf(markSharedLayerFailure(layer, failure)), "missing");
  });

  it("rehydrates a renamed layer from the library filename", () => {
    const renamed = geojsonLayer({
      name: "Tuyen thu nghiem",
      metadata: { sharedDatasetId: "dataset-1" },
      geojson: undefined,
    });
    assert.equal(resolveSharedDatasetFilename(renamed, "khaosat.dxf"), "khaosat.dxf");
  });

  it("marks a conversion or network failure as failed", () => {
    const failure = classifySharedDatasetError(new Error("duckdb"), true);
    assert.equal(sharedLayerFailureOf(markSharedLayerFailure(layer, failure)), "failed");
  });
});

const THREE = {
  type: "FeatureCollection" as const,
  features: [0, 1, 2].map((index) => ({
    type: "Feature" as const,
    properties: { index },
    geometry: { type: "Point" as const, coordinates: [index, index] },
  })),
};

function libraryLayer(id: string, datasetId: string) {
  return geojsonLayer({
    id,
    metadata: { sharedDatasetId: datasetId },
    geojson: undefined,
  });
}

describe("shared library workspace round trip", () => {
  it("puts the features back after a library layer is saved by reference", async () => {
    const layer = geojsonLayer({
      id: "roads",
      metadata: { sharedDatasetId: "ds-1" },
      geojson: THREE,
    });
    const [saved] = prepareCollaborationLayers([layer], new Map());
    assert.equal(saved.geojson, undefined);
    assert.equal(saved.metadata.sharedDatasetId, "ds-1");
    const store = [saved];
    await rehydrateSharedLayers({
      layers: store,
      token: "tok",
      session: createSharedRehydrateSession(),
      listDatasets: async () => [{ id: "ds-1", filename: "roads.dxf" }],
      loadFeatures: async () => THREE,
      getLayer: (id) => store.find((item) => item.id === id),
      updateLayer: (id, patch) => {
        const index = store.findIndex((item) => item.id === id);
        store[index] = { ...store[index], ...patch };
      },
    });
    assert.equal(store[0].geojson?.features.length, 3);
  });

  it("round-trips a local-file layer unchanged", async () => {
    const layer = geojsonLayer({
      id: "local",
      geojson: undefined,
      metadata: {
        externalNativeLayer: true,
        sourceKind: "maplibre-gl-vector",
        localFileReloadable: true,
      },
    });
    const [saved] = prepareCollaborationLayers([layer], new Map([["local", THREE]]));
    assert.equal(saved.metadata.embeddedGeoJSON, THREE);
    assert.equal(saved.metadata.sharedDatasetId, undefined);
    let loads = 0;
    await rehydrateSharedLayers({
      layers: [saved],
      token: "tok",
      session: createSharedRehydrateSession(),
      listDatasets: async () => {
        throw new Error("a local file is not a library layer");
      },
      loadFeatures: async () => {
        loads += 1;
        return THREE;
      },
      getLayer: () => saved,
      updateLayer: () => {},
    });
    assert.equal(loads, 0);
    assert.equal(saved.metadata.embeddedGeoJSON, THREE);
  });

  it("does not retry a layer a later snapshot already marked failed", async () => {
    const session = createSharedRehydrateSession();
    const store = [libraryLayer("roads", "ds-1")];
    let loads = 0;
    const run = () =>
      rehydrateSharedLayers({
        layers: store,
        token: "tok",
        session,
        listDatasets: async () => [{ id: "ds-1", filename: "roads.dxf" }],
        loadFeatures: async () => {
          loads += 1;
          throw new Error("nope");
        },
        getLayer: (id) => store.find((item) => item.id === id),
        updateLayer: (id, patch) => {
          const index = store.findIndex((item) => item.id === id);
          store[index] = { ...store[index], ...patch };
        },
      });
    await run();
    assert.equal(loads, 1);
    assert.equal(store[0].metadata.sharedDatasetLoad, "failed");
    await run();
    assert.equal(loads, 1);
  });

  it("does not start a second fetch while one is already in flight", async () => {
    const session = createSharedRehydrateSession();
    const store = [libraryLayer("roads", "ds-1")];
    let loads = 0;
    let release: (features: typeof THREE) => void = () => {};
    const gate = new Promise<typeof THREE>((resolve) => {
      release = resolve;
    });
    const run = () =>
      rehydrateSharedLayers({
        layers: store,
        token: "tok",
        session,
        listDatasets: async () => [{ id: "ds-1", filename: "roads.dxf" }],
        loadFeatures: () => {
          loads += 1;
          return gate;
        },
        getLayer: (id) => store.find((item) => item.id === id),
        updateLayer: (id, patch) => {
          const index = store.findIndex((item) => item.id === id);
          store[index] = { ...store[index], ...patch };
        },
      });
    const first = run();
    const second = run();
    for (let i = 0; i < 5 && loads < 1; i += 1) await Promise.resolve();
    assert.equal(loads, 1);
    release(THREE);
    await first;
    await second;
    assert.equal(loads, 1);
    assert.equal(store[0].geojson?.features.length, 3);
  });

  it("retries a settled failure when the share token changes", async () => {
    const session = createSharedRehydrateSession();
    session.token = "old";
    const store = [markSharedLayerFailure(libraryLayer("roads", "ds-1"), "needs-sign-in")];
    let loads = 0;
    const run = (token: string) =>
      rehydrateSharedLayers({
        layers: store,
        token,
        session,
        listDatasets: async () => [{ id: "ds-1", filename: "roads.dxf" }],
        loadFeatures: async () => {
          loads += 1;
          assert.equal(store[0].metadata.sharedDatasetLoad, undefined);
          return THREE;
        },
        getLayer: (id) => store.find((item) => item.id === id),
        updateLayer: (id, patch) => {
          const index = store.findIndex((item) => item.id === id);
          store[index] = { ...store[index], ...patch };
        },
      });
    await run("old");
    assert.equal(loads, 0);
    assert.equal(store[0].metadata.sharedDatasetLoad, "needs-sign-in");
    await run("new");
    assert.equal(loads, 1);
    assert.equal(store[0].geojson?.features.length, 3);
    assert.equal(store[0].metadata.sharedDatasetLoad, undefined);
  });

  it("lists the library once for a pass over several layers", async () => {
    const store = [libraryLayer("a", "ds-1"), libraryLayer("b", "ds-2"), libraryLayer("c", "ds-3")];
    let lists = 0;
    let loads = 0;
    await rehydrateSharedLayers({
      layers: store,
      token: "tok",
      session: createSharedRehydrateSession(),
      listDatasets: async () => {
        lists += 1;
        return [
          { id: "ds-1", filename: "a.dxf" },
          { id: "ds-2", filename: "b.dxf" },
          { id: "ds-3", filename: "c.dxf" },
        ];
      },
      loadFeatures: async (_datasetId, _layer, _token, filename) => {
        loads += 1;
        assert.equal(typeof filename, "string");
        return THREE;
      },
      getLayer: (id) => store.find((item) => item.id === id),
      updateLayer: (id, patch) => {
        const index = store.findIndex((item) => item.id === id);
        store[index] = { ...store[index], ...patch };
      },
    });
    assert.equal(lists, 1);
    assert.equal(loads, 3);
  });

  it("does not treat an empty pass as the token the saved failure was settled against", async () => {
    const session = createSharedRehydrateSession();
    await rehydrateSharedLayers({
      layers: [],
      token: "tok",
      session,
      listDatasets: async () => [],
      loadFeatures: async () => THREE,
      getLayer: () => undefined,
      updateLayer: () => {},
    });
    const store = [markSharedLayerFailure(libraryLayer("roads", "ds-1"), "needs-sign-in")];
    let loads = 0;
    await rehydrateSharedLayers({
      layers: store,
      token: "tok",
      session,
      listDatasets: async () => [{ id: "ds-1", filename: "roads.dxf" }],
      loadFeatures: async () => {
        loads += 1;
        return THREE;
      },
      getLayer: (id) => store.find((item) => item.id === id),
      updateLayer: (id, patch) => {
        const index = store.findIndex((item) => item.id === id);
        store[index] = { ...store[index], ...patch };
      },
    });
    assert.equal(loads, 1);
  });
});
