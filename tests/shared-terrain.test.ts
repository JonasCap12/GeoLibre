import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SHARED_TERRAIN_KEY,
  applySharedTerrain,
  clearSharedTerrainCache,
  isTerrainDatasetFile,
  readSharedTerrain,
  sharedTerrainBlob,
  withSharedTerrain,
  type SharedTerrainEngine,
} from "../apps/geolibre-desktop/src/lib/shared-terrain.ts";

const TIFF = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0]);

function fetcher(result: Uint8Array | Error) {
  const calls: { id: string; token: string | undefined }[] = [];
  const fetchBytes = async (id: string, options: { token?: string } = {}) => {
    calls.push({ id, token: options.token });
    if (result instanceof Error) throw result;
    return new Uint8Array(result) as Uint8Array<ArrayBuffer>;
  };
  return { calls, fetchBytes: fetchBytes as unknown as Parameters<typeof sharedTerrainBlob>[2] };
}

function engine(terrainSource: boolean, applied = true) {
  const sources: (string | Blob | null)[] = [];
  const value: SharedTerrainEngine = {
    capabilities: { terrainSource } as SharedTerrainEngine["capabilities"],
    async setTerrainCogSource(source) {
      sources.push(source);
      return applied;
    },
  };
  return { value, sources };
}

beforeEach(() => clearSharedTerrainCache());

describe("the project's shared terrain record", () => {
  it("reads a valid record and trims the id", () => {
    assert.deepEqual(
      readSharedTerrain({ [SHARED_TERRAIN_KEY]: { datasetId: " abc ", name: "Địa hình" } }),
      {
        datasetId: "abc",
        name: "Địa hình",
      },
    );
  });

  it("ignores a missing or malformed record", () => {
    assert.equal(readSharedTerrain(undefined), null);
    assert.equal(readSharedTerrain({}), null);
    assert.equal(readSharedTerrain({ [SHARED_TERRAIN_KEY]: "abc" }), null);
    assert.equal(readSharedTerrain({ [SHARED_TERRAIN_KEY]: { datasetId: "  " } }), null);
    assert.equal(readSharedTerrain({ [SHARED_TERRAIN_KEY]: { datasetId: 7 } }), null);
    assert.deepEqual(readSharedTerrain({ [SHARED_TERRAIN_KEY]: { datasetId: "x" } }), {
      datasetId: "x",
      name: "",
    });
  });

  it("sets, replaces and removes the record without touching the rest", () => {
    const original = { title: "Cao tốc" };
    const set = withSharedTerrain(original, { datasetId: "a", name: "A" });
    assert.deepEqual(set, {
      title: "Cao tốc",
      [SHARED_TERRAIN_KEY]: { datasetId: "a", name: "A" },
    });
    assert.deepEqual(original, { title: "Cao tốc" }, "never mutates");
    const replaced = withSharedTerrain(set, { datasetId: "b", name: "B" });
    assert.deepEqual(readSharedTerrain(replaced), { datasetId: "b", name: "B" });
    assert.deepEqual(withSharedTerrain(replaced, null), { title: "Cao tốc" });
  });

  it("treats only GeoTIFF file names as terrain", () => {
    for (const name of ["dia-hinh.tif", "DEM.TIFF", "a.Tif "])
      assert.equal(isTerrainDatasetFile(name), true, name);
    for (const name of ["bridge.dxf", "route.kmz", "tif", "x.tif.zip"])
      assert.equal(isTerrainDatasetFile(name), false, name);
  });
});

describe("downloading the terrain", () => {
  it("downloads once per dataset, with the caller's token, even across a refreshed sign-in", async () => {
    const { calls, fetchBytes } = fetcher(TIFF);
    const a = await sharedTerrainBlob("d1", "token-a", fetchBytes);
    const again = await sharedTerrainBlob("d1", "token-a", fetchBytes);
    assert.equal(a, again);
    assert.equal(a.type, "image/tiff");
    assert.deepEqual(new Uint8Array(await a.arrayBuffer()), TIFF);
    // The cookie session swaps its access token every few minutes: no new download.
    assert.equal(await sharedTerrainBlob("d1", "token-b", fetchBytes), a);
    await sharedTerrainBlob("d9", "token-b", fetchBytes);
    assert.deepEqual(calls, [
      { id: "d1", token: "token-a" },
      { id: "d9", token: "token-b" },
    ]);
    clearSharedTerrainCache();
    await sharedTerrainBlob("d1", "token-c", fetchBytes);
    assert.equal(calls.length, 3, "signed out and in again: downloads with the new sign-in");
  });

  it("forgets a failed download so the next attempt retries", async () => {
    const failing = fetcher(new Error("403"));
    await assert.rejects(sharedTerrainBlob("d2", "t", failing.fetchBytes), /403/);
    const working = fetcher(TIFF);
    await sharedTerrainBlob("d2", "t", working.fetchBytes);
    assert.equal(working.calls.length, 1);
  });
});

describe("applying the terrain to the map", () => {
  const ref = { datasetId: "d3", name: "Địa hình thiết kế" };

  it("hands the downloaded GeoTIFF to the engine as its terrain source", async () => {
    const { fetchBytes } = fetcher(TIFF);
    const { value, sources } = engine(true);
    assert.equal(await applySharedTerrain(value, ref, "t", fetchBytes), "applied");
    assert.equal(sources.length, 1);
    assert.ok(sources[0] instanceof Blob);
  });

  it("reports a later terrain choice that won the race", async () => {
    const { fetchBytes } = fetcher(TIFF);
    assert.equal(
      await applySharedTerrain(engine(true, false).value, ref, "t", fetchBytes),
      "superseded",
    );
  });

  it("does nothing on a renderer without custom terrain sources", async () => {
    const { calls, fetchBytes } = fetcher(TIFF);
    const { value, sources } = engine(false);
    assert.equal(await applySharedTerrain(value, ref, "t", fetchBytes), "unsupported");
    assert.equal(calls.length, 0, "no download for a renderer that cannot use it");
    assert.equal(sources.length, 0);
  });

  it("fails when the download fails", async () => {
    const { fetchBytes } = fetcher(new Error("network"));
    await assert.rejects(applySharedTerrain(engine(true).value, ref, "t", fetchBytes), /network/);
  });
});

describe("wiring", () => {
  it("DesktopShell applies the shared terrain after the saved terrain", () => {
    const shell = readFileSync(
      fileURLToPath(
        new URL("../apps/geolibre-desktop/src/components/layout/DesktopShell.tsx", import.meta.url),
      ),
      "utf8",
    );
    const restore = shell.indexOf(
      "useTerrainRestore(mapControllerRef, mapReadyGeneration, projectGeneration)",
    );
    const shared = shell.indexOf(
      "useSharedTerrain(mapControllerRef, mapReadyGeneration, projectGeneration)",
    );
    assert.ok(restore > 0 && shared > restore, "useSharedTerrain must run after useTerrainRestore");
  });
});
