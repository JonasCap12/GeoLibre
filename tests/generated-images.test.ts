import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as maplibregl from "maplibre-gl";
import {
  ensureGeneratedImageHandler,
  registerGeneratedImage,
} from "../packages/map/src/generated-images";

/**
 * A removed MapLibre map keeps its object until GC, but `remove()` has already
 * deleted `style`. `hasImage` then throws, and layer sync calls it for every
 * map still in the registry. That throw is what blanks the map behind the
 * error boundary while a peer's snapshots keep driving `syncLayers`.
 */
function stubMap(): {
  map: maplibregl.Map;
  calls: string[];
  holdImage: (id: string) => void;
  killStyle: () => void;
  emit: (type: string, event?: unknown) => void;
} {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const images = new Set<string>();
  const calls: string[] = [];
  let style: object | null = {};
  const map = {
    get style() {
      return style;
    },
    on(type: string, handler: (event: unknown) => void) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    off(type: string, handler: (event: unknown) => void) {
      const list = handlers.get(type);
      if (!list) return;
      handlers.set(
        type,
        list.filter((entry) => entry !== handler),
      );
    },
    hasImage(id: string) {
      calls.push(`hasImage:${id}`);
      if (style == null) {
        throw new TypeError("Cannot read properties of undefined (reading 'getImage')");
      }
      return images.has(id);
    },
    removeImage(id: string) {
      calls.push(`removeImage:${id}`);
      images.delete(id);
    },
    addImage(id: string) {
      calls.push(`addImage:${id}`);
      if (style == null) {
        throw new TypeError("Cannot read properties of undefined (reading 'addImage')");
      }
      images.add(id);
    },
  };
  return {
    map: map as unknown as maplibregl.Map,
    calls,
    holdImage: (id: string) => {
      images.add(id);
    },
    killStyle: () => {
      style = null;
    },
    emit: (type, event) => {
      for (const handler of [...(handlers.get(type) ?? [])]) handler(event);
    },
  };
}

describe("generated images on a map whose style is gone", () => {
  it("does not throw when a map in the registry has been destroyed", () => {
    const dead = stubMap();
    ensureGeneratedImageHandler(dead.map);
    dead.killStyle();
    assert.doesNotThrow(() => {
      registerGeneratedImage("geolibre-dead-only", () => null);
    });
  });

  it("does not call hasImage after MapLibre's real remove() shape", () => {
    // remove() does `delete this.style` and then sets `_removed`. A getter that
    // returns null keeps `"style" in map` true, so it never reaches that flag.
    // This map stays in the registry: the `remove` event is what drops it, and
    // that event is not fired here.
    const handlers = new Map<string, Array<() => void>>();
    const map: {
      style?: object;
      _removed: boolean;
      on: (type: string, handler: () => void) => void;
      hasImage: () => boolean;
    } = {
      style: {},
      _removed: false,
      on(type, handler) {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
      hasImage() {
        throw new TypeError("Cannot read properties of undefined (reading 'getImage')");
      },
    };
    ensureGeneratedImageHandler(map as unknown as maplibregl.Map);
    delete map.style;
    map._removed = true;
    try {
      assert.doesNotThrow(() => {
        registerGeneratedImage("geolibre-removed-flag", () => null);
      });
    } finally {
      // Drop it so a failure here does not make every later registration throw.
      for (const handler of handlers.get("remove") ?? []) handler();
    }
  });

  it("still refreshes a live map in the same pass as a destroyed one", () => {
    const dead = stubMap();
    const live = stubMap();
    ensureGeneratedImageHandler(dead.map);
    ensureGeneratedImageHandler(live.map);
    const id = "geolibre-mixed-alive";
    live.holdImage(id);
    dead.killStyle();
    registerGeneratedImage(id, () => ({
      image: { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) },
      pixelRatio: 1,
    }));
    assert.ok(live.calls.includes(`removeImage:${id}`));
    assert.ok(live.calls.includes(`addImage:${id}`));
  });

  it("drops a destroyed map from the registry when it fires remove", () => {
    const removed = stubMap();
    ensureGeneratedImageHandler(removed.map);
    removed.emit("remove");
    const id = "geolibre-after-remove";
    removed.holdImage(id);
    registerGeneratedImage(id, () => ({
      image: { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) },
      pixelRatio: 1,
    }));
    assert.equal(
      removed.calls.filter(
        (call) => call.startsWith("hasImage:") || call.startsWith("removeImage:"),
      ).length,
      0,
    );
  });

  it("does not throw when the map dies before an async image resolves", async () => {
    const dead = stubMap();
    ensureGeneratedImageHandler(dead.map);
    let resolveImage: (
      value: {
        image: { width: number; height: number; data: Uint8Array };
        pixelRatio: number;
      } | null,
    ) => void = () => {};
    const id = "geolibre-async-resolve";
    registerGeneratedImage(
      id,
      () =>
        new Promise((resolve) => {
          resolveImage = resolve;
        }),
    );
    dead.emit("styleimagemissing", { id });
    dead.killStyle();
    resolveImage({
      image: { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) },
      pixelRatio: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dead.calls.includes(`addImage:${id}`), false);
  });

  it("does not throw when the map dies before an async image rejects", async () => {
    const dead = stubMap();
    ensureGeneratedImageHandler(dead.map);
    let rejectImage: (error: Error) => void = () => {};
    const id = "geolibre-async-reject";
    registerGeneratedImage(
      id,
      () =>
        new Promise((_resolve, reject) => {
          rejectImage = reject;
        }),
    );
    dead.emit("styleimagemissing", { id });
    dead.killStyle();
    rejectImage(new Error("rasterize failed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dead.calls.includes(`addImage:${id}`), false);
  });
});
