import {
  act,
  fireEvent,
  i18n,
  mockFetch,
  render,
  screen,
  useAppStore,
  useDesktopSettingsStore,
  waitFor,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";
import { createElement, useState, type ReactNode } from "react";
import type { MapEngine } from "@geolibre/map";
import type { AddDataShellContextValue } from "../apps/geolibre-desktop/src/components/layout/add-data/context";
import type { SharedDataset } from "../apps/geolibre-desktop/src/lib/shared-datasets";

const { AddDataShellProvider } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/context");
const { SharedDataSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/SharedDataSource");
const { useSharedTerrain } = await import("../apps/geolibre-desktop/src/hooks/useSharedTerrain");
const { SHARED_TERRAIN_KEY, clearSharedTerrainCache, readSharedTerrain } =
  await import("../apps/geolibre-desktop/src/lib/shared-terrain");
const { useNotificationStore } = await import("../apps/geolibre-desktop/src/lib/notify");
const t = i18n.t.bind(i18n);

const terrain: SharedDataset = {
  id: "terrain-id",
  name: "Địa hình thiết kế Km144–Km161",
  description: "",
  filename: "CaoToc_dia-hinh-thiet-ke.tif",
  contentType: "image/tiff",
  sizeBytes: 22_000_000,
  visibility: "team",
  downloads: 0,
  owner: "owner",
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-17T00:00:00Z",
  tags: [],
  contentUrl: "https://example.com/content",
};
const TIFF = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0]);

function setToken(shareToken: string) {
  act(() => {
    const store = useDesktopSettingsStore.getState();
    store.setDesktopSettings({ ...store.desktopSettings, shareToken });
  });
}
function setTerrainRecord(datasetId: string | null) {
  act(() => {
    const { metadata } = useAppStore.getState();
    const { [SHARED_TERRAIN_KEY]: _old, ...rest } = metadata;
    useAppStore.setState({
      metadata: datasetId
        ? { ...rest, [SHARED_TERRAIN_KEY]: { datasetId, name: terrain.name } }
        : rest,
    });
  });
}
function mountSource(children: ReactNode) {
  function Shell() {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const value: AddDataShellContextValue = {
      mapControllerRef: { current: null },
      existingLayers: [],
      isSubmitting,
      setIsSubmitting,
      addLayer() {},
      closeDialog() {},
      targetGroupId: null,
      martin: {} as AddDataShellContextValue["martin"],
    };
    return createElement(AddDataShellProvider, { value, children });
  }
  return render(createElement(Shell));
}
function fakeEngine(terrainSource = true) {
  const sources: (string | Blob | null)[] = [];
  const engine = {
    capabilities: { terrainSource },
    async setTerrainCogSource(source: string | Blob | null) {
      sources.push(source);
      return true;
    },
  } as unknown as MapEngine;
  return { engine, sources };
}
function mountHook(engine: MapEngine, projectGeneration = 0) {
  function Probe({ generation }: { generation: number }) {
    useSharedTerrain({ current: engine }, 1, generation);
    return null;
  }
  const result = render(createElement(Probe, { generation: projectGeneration }));
  return {
    ...result,
    reopen: (generation: number) => result.rerender(createElement(Probe, { generation })),
  };
}

beforeEach(() => {
  clearSharedTerrainCache();
  useNotificationStore.setState({ notifications: [] });
});

it("offers a library GeoTIFF as the project's terrain instead of a layer, and records it", async () => {
  setToken("terrain-ui-token");
  setTerrainRecord(null);
  act(() => {
    const state = useAppStore.getState();
    state.setPreferences({
      ...state.preferences,
      map: {
        ...state.preferences.map,
        terrainEnabled: false,
        terrainSource: "http://127.0.0.1:5173/@fs/old.tif",
      },
    });
  });
  mockFetch(async () => Response.json({ datasets: [terrain] }));
  mountSource(createElement(SharedDataSource));
  await screen.findByRole("option", { name: /Địa hình thiết kế/ });
  assert.ok(screen.getByText(t("sharedTerrain.tiffNotLayer")));
  const add = screen.getByRole("button", {
    name: t("addData.shared.addLayer"),
  }) as HTMLButtonElement;
  assert.equal(add.disabled, true, "a GeoTIFF is not read as a vector layer");

  fireEvent.click(screen.getByRole("button", { name: t("sharedTerrain.useAsTerrain") }));
  const state = useAppStore.getState();
  assert.deepEqual(readSharedTerrain(state.metadata), {
    datasetId: terrain.id,
    name: terrain.name,
  });
  assert.equal(state.preferences.map.terrainEnabled, true);
  assert.equal(
    state.preferences.map.terrainSource,
    undefined,
    "no saved URL competes with the library copy",
  );
  assert.equal(state.isDirty, true);
  await screen.findByText(t("sharedTerrain.current", { name: terrain.name }));

  fireEvent.click(screen.getByRole("button", { name: t("sharedTerrain.clear") }));
  assert.equal(readSharedTerrain(useAppStore.getState().metadata), null);
  await screen.findByText(t("sharedTerrain.cleared"));
});

it("downloads the project's terrain with the viewer's own sign-in and puts it on the map", async () => {
  setToken("viewer-token");
  setTerrainRecord(terrain.id);
  const requests: string[] = [];
  mockFetch(async (input, init) => {
    requests.push(`${String(input)} ${new Headers(init?.headers).get("Authorization")}`);
    return new Response(TIFF);
  });
  const { engine, sources } = fakeEngine();
  const hook = mountHook(engine);
  await waitFor(() => assert.equal(sources.length, 1));
  assert.ok(sources[0] instanceof Blob);
  assert.match(requests[0], /\/api\/datasets\/terrain-id\/content Bearer viewer-token$/);

  // Reopening the project resets the terrain (useTerrainRestore): apply again, from the cache.
  hook.reopen(1);
  await waitFor(() => assert.equal(sources.length, 2));
  assert.equal(requests.length, 1, "downloaded once");

  // A refreshed sign-in (new access token) neither downloads nor applies again.
  setToken("viewer-token-refreshed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sources.length, 2);
  assert.equal(requests.length, 1);

  // Removed from the project: back to what the project saves.
  setTerrainRecord(null);
  await waitFor(() => assert.equal(sources.length, 3));
  assert.equal(sources[2], null);
});

it("waits for a sign-in, and reports a failed download", async () => {
  setToken("");
  setTerrainRecord(terrain.id);
  let failing = true;
  mockFetch(async () =>
    failing ? new Response("forbidden", { status: 403 }) : new Response(TIFF),
  );
  const { engine, sources } = fakeEngine();
  mountHook(engine);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sources.length, 0, "nothing without a sign-in");

  setToken("member-token");
  await waitFor(() =>
    assert.ok(useNotificationStore.getState().notifications.some((n) => n.kind === "error")),
  );
  assert.equal(sources.length, 0);

  // Signing in again (a new token) retries.
  failing = false;
  setToken("member-token-2");
  await waitFor(() => assert.equal(sources.length, 1));
});
