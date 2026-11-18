import { act, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderHook } from "@testing-library/react";
import type { MapEngine } from "@geolibre/map";

// Loaded after the harness so its Vite globals are handled.
const { useTerrainRestore } = await import("../apps/geolibre-desktop/src/hooks/useTerrainRestore");
const { TERRAIN_TOGGLE_EVENT } = await import("@geolibre/map");

/** The calls the hook makes on the engine, in order. */
function fakeEngine(options: { terrainButton: boolean }) {
  const calls: string[] = [];
  const engine = {
    capabilities: { terrainSource: false },
    setBuiltInControlVisible: (control: string, visible: boolean) => {
      calls.push(`visible:${control}:${visible}`);
      return true;
    },
    ...(options.terrainButton
      ? {
          showTerrainToggle: () => {
            calls.push("showTerrainToggle");
            return true;
          },
        }
      : {}),
    setTerrainExaggeration() {},
    getTerrainExaggeration: () => 1,
    getTerrainCogSource: () => null,
    hasCustomTerrainSource: () => false,
    setTerrainCogSource: async () => true,
  };
  return { engine: engine as unknown as MapEngine, calls };
}

function setTerrainEnabled(enabled: boolean) {
  const { preferences } = useAppStore.getState();
  useAppStore.setState({
    preferences: { ...preferences, map: { ...preferences.map, terrainEnabled: enabled } },
  });
}

describe("useTerrainRestore keeps the terrain button on the map", () => {
  it("shows the button with terrain off when the project has terrain off", () => {
    const { engine, calls } = fakeEngine({ terrainButton: true });
    setTerrainEnabled(false);

    renderHook(() => useTerrainRestore({ current: engine }, 1, 1));

    assert.deepEqual(calls, ["showTerrainToggle"]);
  });

  it("turns terrain on through the control when the project has terrain on", () => {
    const { engine, calls } = fakeEngine({ terrainButton: true });
    setTerrainEnabled(true);

    renderHook(() => useTerrainRestore({ current: engine }, 1, 1));

    assert.deepEqual(calls, ["visible:terrain:true"]);
  });

  it("still switches relief off on an engine with no terrain button", () => {
    const { engine, calls } = fakeEngine({ terrainButton: false });
    setTerrainEnabled(false);

    renderHook(() => useTerrainRestore({ current: engine }, 1, 1));

    assert.deepEqual(calls, ["visible:terrain:false"]);
  });

  it("saves a click on the button in the project", () => {
    const { engine } = fakeEngine({ terrainButton: true });
    setTerrainEnabled(true);
    useAppStore.setState({ isDirty: false });
    renderHook(() => useTerrainRestore({ current: engine }, 1, 1));

    act(() => {
      window.dispatchEvent(new CustomEvent(TERRAIN_TOGGLE_EVENT, { detail: { enabled: false } }));
    });

    assert.equal(useAppStore.getState().preferences.map.terrainEnabled, false);
    assert.equal(useAppStore.getState().isDirty, true, "the change reaches the autosave");
  });
});
