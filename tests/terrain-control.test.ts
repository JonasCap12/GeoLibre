import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type * as maplibregl from "maplibre-gl";
import {
  TerrainControl,
  isStyleLoadingError,
  setTerrainSafely,
} from "../packages/map/src/terrain-control";

// TerrainControl.onAdd builds DOM nodes; node:test has no DOM, so stand up a
// minimal element/document just rich enough for the methods the control calls.
interface FakeElement {
  className: string;
  type: string;
  title: string;
  children: FakeElement[];
  classList: { has: (n: string) => boolean; toggle: (n: string, f?: boolean) => boolean };
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: FakeElement) => FakeElement;
  addEventListener: (type: string, handler: () => void) => void;
  remove: () => void;
  emit: (type: string) => void;
}

function makeFakeElement(): FakeElement {
  const classes = new Set<string>();
  const listeners: Record<string, Array<() => void>> = {};
  const el: FakeElement = {
    className: "",
    type: "",
    title: "",
    children: [],
    classList: {
      has: (name) => classes.has(name),
      toggle: (name, force) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
    attributes: {},
    setAttribute: (name, value) => {
      el.attributes[name] = value;
    },
    appendChild: (child) => {
      el.children.push(child);
      return child;
    },
    addEventListener: (type, handler) => {
      (listeners[type] ??= []).push(handler);
    },
    remove: () => {},
    emit: (type) => {
      for (const handler of listeners[type] ?? []) handler();
    },
  };
  return el;
}

const TERRAIN_SOURCE = "geolibre-terrain-dem";
// Mirrors the control's private DOUBLE_CLICK_MS: advancing timers by exactly the
// debounce window fires the pending single-click toggle.
const DOUBLE_CLICK_MS = 250;

interface FakeMap {
  map: maplibregl.Map;
  setTerrainCalls: Array<maplibregl.TerrainSpecification | null>;
  clampCalls: boolean[];
  emitTerrain: () => void;
}

function makeFakeMap(): FakeMap {
  let terrain: maplibregl.TerrainSpecification | null = null;
  const handlers: Record<string, Array<() => void>> = {};
  const setTerrainCalls: Array<maplibregl.TerrainSpecification | null> = [];
  const clampCalls: boolean[] = [];
  const map = {
    getTerrain: () => terrain,
    setTerrain: (spec: maplibregl.TerrainSpecification | null) => {
      terrain = spec;
      setTerrainCalls.push(spec);
      for (const handler of handlers.terrain ?? []) handler();
    },
    // Recorded so a test can assert the control never unclamps the center.
    setCenterClampedToGround: (value: boolean) => {
      clampCalls.push(value);
    },
    on: (type: string, handler: () => void) => {
      (handlers[type] ??= []).push(handler);
    },
    off: (type: string, handler: () => void) => {
      handlers[type] = (handlers[type] ?? []).filter((h) => h !== handler);
    },
  };
  return {
    map: map as unknown as maplibregl.Map,
    setTerrainCalls,
    clampCalls,
    emitTerrain: () => {
      for (const handler of handlers.terrain ?? []) handler();
    },
  };
}

/**
 * Mount a control on a fresh fake map and return the pieces a test drives: the
 * control, the map spy, and the button whose click events we simulate.
 */
function mount(options?: { onOpenSettings?: () => void; exaggeration?: number }) {
  const created: FakeElement[] = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const el = makeFakeElement();
      created.push(el);
      return el;
    },
  };
  const fake = makeFakeMap();
  const control = new TerrainControl({
    source: TERRAIN_SOURCE,
    exaggeration: options?.exaggeration,
    onOpenSettings: options?.onOpenSettings,
  });
  control.onAdd(fake.map);
  // created[0] is the container div, created[1] the button, created[2] the icon.
  const button = created[1];
  return { control, fake, button };
}

describe("TerrainControl", () => {
  afterEach(() => {
    mock.timers.reset();
    delete (globalThis as { document?: unknown }).document;
  });

  it("toggles terrain on after a lone click settles", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { control, fake, button } = mount();

    assert.equal(control.isEnabled(), false);
    button.emit("click");
    // Still pending until the double-click window elapses.
    assert.equal(fake.setTerrainCalls.length, 0);
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(control.isEnabled(), true);
    assert.deepEqual(fake.setTerrainCalls.at(-1), {
      source: TERRAIN_SOURCE,
      exaggeration: 1,
    });

    // A second lone click toggles it back off.
    button.emit("click");
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(control.isEnabled(), false);
    assert.equal(fake.setTerrainCalls.at(-1), null);
  });

  it("opens settings on a double click without flickering terrain", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const onOpenSettings = mock.fn();
    const { control, fake, button } = mount({ onOpenSettings });

    button.emit("click");
    button.emit("click");
    // The second click cancels the pending toggle, so terrain is only ever
    // enabled once (for the dialog) — never toggled on then back off.
    assert.equal(onOpenSettings.mock.callCount(), 1);
    assert.equal(control.isEnabled(), true);
    assert.equal(fake.setTerrainCalls.length, 1);

    // The cancelled single-click toggle must not fire late.
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(fake.setTerrainCalls.length, 1);
  });

  it("ignores a 3rd rapid click so terrain stays on under the open dialog", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const onOpenSettings = mock.fn();
    const { control, fake, button } = mount({ onOpenSettings });

    button.emit("click"); // arms the single-click toggle
    button.emit("click"); // double-click → opens settings, enables terrain
    button.emit("click"); // 3rd rapid click must be swallowed, not re-armed
    assert.equal(control.isEnabled(), true);
    const callsAfterOpen = fake.setTerrainCalls.length;

    // The suppression window elapses without any late toggle firing.
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(control.isEnabled(), true);
    assert.equal(fake.setTerrainCalls.length, callsAfterOpen);

    // Once suppression lifts, a fresh click toggles normally again.
    button.emit("click");
    t.mock.timers.tick(DOUBLE_CLICK_MS);
    assert.equal(control.isEnabled(), false);
  });

  it("applies a new exaggeration live only while terrain is enabled", () => {
    const { control, fake } = mount();

    // No-op (and no setTerrain) while terrain is off, but the value is retained.
    control.setExaggeration(2.5);
    assert.equal(fake.setTerrainCalls.length, 0);
    assert.equal(control.getExaggeration(), 2.5);

    control.setEnabled(true);
    assert.deepEqual(fake.setTerrainCalls.at(-1), {
      source: TERRAIN_SOURCE,
      exaggeration: 2.5,
    });

    // Now live: changing it re-applies terrain immediately.
    control.setExaggeration(4);
    assert.deepEqual(fake.setTerrainCalls.at(-1), {
      source: TERRAIN_SOURCE,
      exaggeration: 4,
    });
  });

  it("clamps invalid exaggeration values defensively", () => {
    const { control, fake } = mount();
    control.setEnabled(true);
    const enabledCall = fake.setTerrainCalls.length;

    // Negatives clamp to 0 (flat); non-finite values are ignored entirely.
    control.setExaggeration(-3);
    assert.equal(control.getExaggeration(), 0);
    assert.deepEqual(fake.setTerrainCalls.at(-1), {
      source: TERRAIN_SOURCE,
      exaggeration: 0,
    });

    control.setExaggeration(Number.NaN);
    assert.equal(control.getExaggeration(), 0);
    control.setExaggeration(Number.POSITIVE_INFINITY);
    assert.equal(control.getExaggeration(), 0);
    // NaN/Infinity did not re-apply terrain (only the -3 clamp call did).
    assert.equal(fake.setTerrainCalls.length, enabledCall + 1);
  });

  it("clamps an invalid exaggeration passed to the constructor", () => {
    assert.equal(mount({ exaggeration: -2 }).control.getExaggeration(), 0);
    assert.equal(mount({ exaggeration: Number.NaN }).control.getExaggeration(), 1);
  });

  it("leaves the center clamped to the terrain while toggling it (#3409)", () => {
    const { control, fake } = mount();

    // Unclamping anchored the center at sea level, so over high terrain the
    // camera hit the ground before maxZoom and zoom (and tile loading) stalled.
    control.setEnabled(true);
    assert.equal(fake.setTerrainCalls.at(-1)?.source, TERRAIN_SOURCE);
    control.setEnabled(false);
    assert.equal(fake.setTerrainCalls.at(-1), null);
    assert.deepEqual(fake.clampCalls, []);
  });

  it("reflects the enabled state on the button class and aria-pressed", () => {
    const { control, button } = mount();
    assert.equal(button.classList.has("maplibregl-ctrl-terrain-enabled"), false);
    assert.equal(button.attributes["aria-pressed"], "false");
    control.setEnabled(true);
    assert.equal(button.classList.has("maplibregl-ctrl-terrain-enabled"), true);
    assert.equal(button.attributes["aria-pressed"], "true");
    control.setEnabled(false);
    assert.equal(button.classList.has("maplibregl-ctrl-terrain-enabled"), false);
    assert.equal(button.attributes["aria-pressed"], "false");
  });
});

// Opening a project applies its saved exaggeration from a React effect; when a
// style was still loading, MapLibre's setTerrain threw "Style is not done
// loading" and the app crashed (owner's live-site diagnostics, 2026-11-17).
describe("terrain changes while a style loads", () => {
  function loadingMap(initial: maplibregl.TerrainSpecification | null) {
    let terrain = initial;
    let loading = true;
    let idle: Array<() => void> = [];
    const applied: Array<maplibregl.TerrainSpecification | null> = [];
    const map = {
      getTerrain: () => terrain,
      setTerrain: (spec: maplibregl.TerrainSpecification | null) => {
        if (loading) throw new Error("Style is not done loading.");
        terrain = spec;
        applied.push(spec);
      },
      once: (event: string, handler: () => void) => {
        if (event === "idle") idle.push(handler);
      },
      on() {},
      off() {},
    };
    return {
      map: map as unknown as maplibregl.Map,
      applied,
      get terrain() {
        return terrain;
      },
      finishLoading() {
        loading = false;
        const handlers = idle;
        idle = [];
        for (const handler of handlers) handler();
      },
    };
  }

  function controlOn(map: maplibregl.Map) {
    (globalThis as { document?: unknown }).document = { createElement: makeFakeElement };
    const control = new TerrainControl({ source: TERRAIN_SOURCE });
    control.onAdd(map);
    return control;
  }

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("recognises MapLibre's style-loading refusal only", () => {
    assert.equal(isStyleLoadingError(new Error("Style is not done loading.")), true);
    assert.equal(isStyleLoadingError(new Error("Source not found")), false);
    assert.equal(isStyleLoadingError("Style is not done loading."), false);
  });

  it("does not throw on an exaggeration change and applies the newest one once idle", () => {
    const fake = loadingMap({ source: TERRAIN_SOURCE, exaggeration: 1 });
    const control = controlOn(fake.map);
    assert.doesNotThrow(() => control.setExaggeration(2));
    assert.doesNotThrow(() => control.setExaggeration(3));
    fake.finishLoading();
    assert.deepEqual(
      fake.applied,
      [{ source: TERRAIN_SOURCE, exaggeration: 3 }],
      "one apply, newest value",
    );
  });

  it("turns terrain off once idle, unless it was turned back on first", () => {
    const off = loadingMap({ source: TERRAIN_SOURCE, exaggeration: 1 });
    assert.doesNotThrow(() => controlOn(off.map).setEnabled(false));
    off.finishLoading();
    assert.equal(off.terrain, null);

    const again = loadingMap({ source: TERRAIN_SOURCE, exaggeration: 1 });
    const control = controlOn(again.map);
    control.setEnabled(false);
    setTerrainSafely(again.map, () => ({ source: TERRAIN_SOURCE, exaggeration: 2 }));
    again.finishLoading();
    assert.deepEqual(again.terrain, { source: TERRAIN_SOURCE, exaggeration: 2 });
    assert.equal(again.applied.length, 1, "the superseded request does not apply");
  });

  it("still throws any other error", () => {
    const map = {
      setTerrain: () => {
        throw new Error("Source not found");
      },
      once() {},
    } as unknown as maplibregl.Map;
    assert.throws(() => setTerrainSafely(map, () => null), /Source not found/);
  });
});
