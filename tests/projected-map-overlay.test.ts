import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { MapEngine } from "../packages/map/src/map-engine";
import {
  mountProjectedElement,
  mountProjectedExtent,
  type ProjectedElementHandle,
  type ProjectedExtentHandle,
} from "../apps/geolibre-desktop/src/lib/projected-map-overlay";

const originalDocument = globalThis.document;
const originalResizeObserver = globalThis.ResizeObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

let pendingFrame: FrameRequestCallback | null = null;

function flushFrame(): void {
  const callback = pendingFrame;
  pendingFrame = null;
  callback?.(0);
}

class TestResizeObserver {
  static instances = 0;
  static disconnects = 0;

  constructor() {
    TestResizeObserver.instances += 1;
  }

  observe(): void {}
  disconnect(): void {
    TestResizeObserver.disconnects += 1;
  }
}

beforeEach(() => {
  TestResizeObserver.instances = 0;
  TestResizeObserver.disconnects = 0;
  pendingFrame = null;
  const { document } = parseHTML("<html><body><div id='map'></div></body></html>");
  Object.assign(globalThis, { document, ResizeObserver: TestResizeObserver });
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    pendingFrame = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {
    pendingFrame = null;
  };
});

afterEach(() => {
  flushFrame();
  Object.assign(globalThis, {
    document: originalDocument,
    ResizeObserver: originalResizeObserver,
    requestAnimationFrame: originalRequestAnimationFrame,
    cancelAnimationFrame: originalCancelAnimationFrame,
  });
});

function engineHarness() {
  const container = document.querySelector<HTMLElement>("#map")!;
  const listeners = new Set<() => void>();
  const engine = {
    getRenderSurface: () => ({
      getContainer: () => container,
      project: ([lng, lat]: [number, number]) => ({ x: lng * 2, y: lat * 3 }),
    }),
    onCameraMove: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onCameraIdle: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as MapEngine;
  return { container, engine, listeners };
}

describe("projected map overlays", () => {
  it("positions, updates, and removes a renderer-neutral marker", () => {
    const { container, engine, listeners } = engineHarness();
    const element = document.createElement("div");
    const handle = mountProjectedElement(engine, element, [10, 5], "bottom");
    flushFrame();
    assert.equal(element.style.transform, "translate(20px, 15px) translate(-50%, -100%)");
    assert.equal(element.parentElement, container);

    handle.setCoordinate([4, 6]);
    flushFrame();
    assert.equal(element.style.transform, "translate(8px, 18px) translate(-50%, -100%)");
    handle.remove();
    assert.equal(element.parentElement, null);
    assert.equal(listeners.size, 0);
  });

  it("updates a projected extent without replacing its SVG", () => {
    const { container, engine, listeners } = engineHarness();
    const handle = mountProjectedExtent(engine, [1, 2, 3, 4], "#2563eb");
    flushFrame();
    const svg = container.querySelector(".geolibre-collab-viewport")!;
    const polygon = svg.querySelector("polygon")!;
    assert.equal(polygon.getAttribute("points"), "2,6 6,6 6,12 2,12");

    handle.setExtent([2, 3, 4, 5]);
    handle.setColor("#dc2626");
    flushFrame();
    assert.equal(polygon.getAttribute("points"), "4,9 8,9 8,15 4,15");
    assert.equal(polygon.getAttribute("stroke"), "#dc2626");
    handle.remove();
    assert.equal(svg.parentElement, null);
    assert.equal(listeners.size, 0);
  });

  it("shares one resize observer across overlays in the same container", () => {
    const { engine } = engineHarness();
    const marker = mountProjectedElement(engine, document.createElement("div"), [1, 2], "bottom");
    const extent = mountProjectedExtent(engine, [1, 2, 3, 4], "#2563eb");

    assert.equal(TestResizeObserver.instances, 1);
    marker.remove();
    assert.equal(TestResizeObserver.disconnects, 0);
    extent.remove();
    assert.equal(TestResizeObserver.disconnects, 1);
  });

  it("does not project a coordinate or extent that is already showing", () => {
    const harness = countingEngine();
    const marker = mountProjectedElement(
      harness.engine,
      document.createElement("div"),
      [1, 2],
      "top-left",
    );
    const extent = mountProjectedExtent(harness.engine, [1, 2, 3, 4], "#2563eb");
    flushFrame();
    harness.reset();

    marker.setCoordinate([1, 2]);
    extent.setExtent([1, 2, 3, 4]);
    flushFrame();
    assert.equal(harness.projects, 0);

    marker.remove();
    extent.remove();
  });

  it("projects each overlay once when several camera events land in one frame", () => {
    const harness = countingEngine();
    const cursors: ProjectedElementHandle[] = [];
    const extents: ProjectedExtentHandle[] = [];
    for (let i = 0; i < 3; i += 1) {
      cursors.push(
        mountProjectedElement(harness.engine, document.createElement("div"), [i, i], "top-left"),
      );
      extents.push(mountProjectedExtent(harness.engine, [i, i, i + 1, i + 1], "#2563eb"));
    }
    flushFrame();
    harness.reset();

    for (let event = 0; event < 8; event += 1) {
      for (const listener of harness.moveListeners) listener();
    }
    flushFrame();
    // 3 cursors + 4 corners × 3 extents. Eight events used to project 120 times.
    assert.equal(harness.projects, 15);
    assert.equal(document.querySelectorAll(".geolibre-collab-viewport").length, 1);

    for (const handle of cursors) handle.remove();
    for (const handle of extents) handle.remove();
  });

  it("projects only the cursor that changed across a burst of presence updates", () => {
    const harness = countingEngine();
    const cursors: ProjectedElementHandle[] = [];
    const extents: ProjectedExtentHandle[] = [];
    for (let i = 0; i < 3; i += 1) {
      cursors.push(
        mountProjectedElement(harness.engine, document.createElement("div"), [i, i], "top-left"),
      );
      extents.push(mountProjectedExtent(harness.engine, [i, i, i + 1, i + 1], "#2563eb"));
    }
    flushFrame();
    harness.reset();

    for (let msg = 0; msg < 25; msg += 1) {
      for (let i = 0; i < 3; i += 1) {
        cursors[i].setCoordinate(i === 0 ? [msg + 1, 1] : [i, i]);
        extents[i].setExtent([i, i, i + 1, i + 1]);
      }
    }
    flushFrame();
    // The same burst used to project 375 times (every participant, every message).
    assert.equal(harness.projects, 1);

    for (const handle of cursors) handle.remove();
    for (const handle of extents) handle.remove();
  });
});

function countingEngine() {
  let projects = 0;
  const container = document.querySelector<HTMLElement>("#map")!;
  const moveListeners = new Set<() => void>();
  const engine = {
    getRenderSurface: () => ({
      getContainer: () => container,
      project: () => {
        projects += 1;
        return { x: 0, y: 0 };
      },
    }),
    onCameraMove: (listener: () => void) => {
      moveListeners.add(listener);
      return () => moveListeners.delete(listener);
    },
    onCameraIdle: () => () => {},
  } as unknown as MapEngine;
  return {
    engine,
    moveListeners,
    get projects() {
      return projects;
    },
    reset() {
      projects = 0;
    },
  };
}
