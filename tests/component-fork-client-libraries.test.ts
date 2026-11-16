import { useAppStore, mockFetch, act } from "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, afterEach, it } from "node:test";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { serializeProject } from "@geolibre/core";

// The plugin registry is an external snapshot dependency, and importing every
// plugin would obscure coverage of these adapters. Keep the snapshot builder real.
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/hooks/usePlugins"))
      return {
        url: "data:text/javascript,export function getPluginManager(){return {getProjectState(){return {}}}}",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
after(() => hook.deregister());
const { loadDuckDbVectorFile } =
  await import("../apps/geolibre-desktop/src/lib/duckdb-vector-loader");
const { loadSharedDatasetFeatures, rehydrateSharedLayersInStore } =
  await import("../apps/geolibre-desktop/src/lib/collaboration-shared-load");
const { collaborationSnapshotMeasure } =
  await import("../apps/geolibre-desktop/src/lib/collaboration-snapshot-measure");
const { buildCollaborationSnapshot } =
  await import("../apps/geolibre-desktop/src/lib/build-project-snapshot");
const { hasCloudWorkspaceBlockingPayload } =
  await import("../apps/geolibre-desktop/src/hooks/useCloudWorkspace");
const bytes = new Uint8Array(readFileSync(new URL("./fixtures/fork-small.dxf", import.meta.url)));
afterEach(() => {
  window.history.replaceState({}, "", "/");
});

it("reads the complete DXF fallback or a named CAD layer while preserving input bytes", async () => {
  const original = bytes.slice();
  const file = { name: "fork-small.dxf", extension: "dxf", data: bytes };
  const all = await loadDuckDbVectorFile(file);
  assert.equal(all.features.length, 2);
  assert.deepEqual(
    all.features.map((f) => f.geometry),
    [
      {
        type: "LineString",
        coordinates: [
          [106, 10],
          [106.1, 10.1],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [107, 11],
          [107.1, 11.1],
        ],
      },
    ],
  );
  const selected = await loadDuckDbVectorFile(file, { layer: "Piers", overrideSourceCrs: " " });
  assert.equal(selected.features.length, 1);
  assert.deepEqual(selected.features[0].geometry, all.features[0].geometry);
  assert.deepEqual(bytes, original);
});

it("loads a shared dataset from its listed filename and tolerates an unavailable listing", async () => {
  for (const failedListing of [false, true]) {
    const layer = geojsonLayer({
      name: "Renamed",
      metadata: { sharedDatasetId: "shared-id", sharedDatasetFilename: "stored.dxf" },
    });
    const requests: string[] = [];
    mockFetch(async (input, init) => {
      const url = String(input);
      requests.push(url);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer library-token");
      if (url.endsWith("/content")) return new Response(bytes);
      if (failedListing) throw new Error("listing unavailable");
      return Response.json({ datasets: [{ id: "shared-id", filename: "listed.DXF" }] });
    });
    assert.equal(
      (await loadSharedDatasetFeatures("shared-id", layer, "library-token")).features.length,
      2,
    );
    assert.equal(requests.length, 2);
    assert.ok(requests[1].endsWith("/api/datasets/shared-id/content"));
  }
});

it("rehydrates current store layers once per pass and keeps deleted layers deleted", async () => {
  const layers = ["one", "two"].map((id) =>
    geojsonLayer({
      id,
      name: "Renamed",
      metadata: {
        sharedDatasetId: id,
        sharedDatasetFilename: "drawing.dxf",
        sharedDatasetLoad: "failed",
      },
    }),
  );
  act(() => useAppStore.setState({ layers }));
  let listings = 0;
  let reads = 0;
  mockFetch(async (input) => {
    if (!String(input).endsWith("/content")) {
      listings++;
      return Response.json({ datasets: layers.map((l) => ({ id: l.id, filename: "listed.dxf" })) });
    }
    reads++;
    if (String(input).includes("/two/")) act(() => useAppStore.getState().removeLayer("two"));
    return new Response(bytes);
  });
  await act(async () => {
    await rehydrateSharedLayersInStore("new-token");
  });
  assert.equal(listings, 1);
  assert.equal(reads, 2);
  const remaining = useAppStore.getState().layers;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].geojson?.features.length, 2);
  assert.equal(remaining[0].metadata.sharedDatasetLoad, undefined);
});

it("measures the exact UTF-8 wire snapshot and counts shared datasets by reference", async () => {
  const layers = [
    geojsonLayer({
      name: "Cầu 日本 🗺️",
      metadata: { sharedDatasetId: "shared" },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { big: "x".repeat(10000) },
            geometry: { type: "Point", coordinates: [106, 10] },
          },
        ],
      },
    }),
  ];
  act(() => useAppStore.setState({ layers }));
  const ref = { current: null };
  const serialized = serializeProject(await buildCollaborationSnapshot(ref));
  const measure = collaborationSnapshotMeasure(ref);
  assert.equal(measure(layers), new TextEncoder().encode(serialized).length);
  assert.ok(measure(layers) < 10000);
  assert.ok(measure(layers) > serialized.length);
});

it("blocks account workspace restore for project, dataset, service and collaboration deep links", () => {
  for (const search of [
    "?project=https://example.com/map.geolibre.json",
    "?data=https://example.com/data.geojson",
    "?add=wms&serviceUrl=https://example.com/wms",
    "?collab=ABCD2345",
  ]) {
    window.history.replaceState({}, "", `/${search}`);
    assert.equal(hasCloudWorkspaceBlockingPayload(), true, search);
  }
  for (const search of [
    "",
    "?theme=dark",
    "?data=invalid",
    "?add=unknown&serviceUrl=https://example.com",
  ]) {
    window.history.replaceState({}, "", `/${search}`);
    assert.equal(hasCloudWorkspaceBlockingPayload(), false, search);
  }
});

it(
  "checks project deep links in an explicitly supplied search",
  {
    todo: "bug: hasCloudWorkspaceBlockingPayload reads project URLs from window.location instead of its search argument",
  },
  () => {
    window.history.replaceState({}, "", "/");
    assert.equal(
      hasCloudWorkspaceBlockingPayload("?project=https://example.com/map.geolibre.json"),
      true,
    );
  },
);
