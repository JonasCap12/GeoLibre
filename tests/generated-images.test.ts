import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as maplibregl from "maplibre-gl";
import {
  ensureGeneratedImageHandler,
  registerGeneratedImage,
  type GeneratedImageResult,
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

describe("generated images resolver", () => {
  it("resolves generated patterns before MapLibre collects the requested images", async () => {
    let resolveMissing: ((id: string) => void | Promise<void>) | undefined;
    let installations = 0;
    const images = new Map<string, unknown>();
    const map = {
      on() {},
      hasImage: (id: string) => images.has(id),
      addImage: (id: string, image: unknown) => images.set(id, image),
      setMissingStyleImageResolver(resolver: typeof resolveMissing) {
        installations += 1;
        resolveMissing = resolver;
      },
    };
    const result: GeneratedImageResult = {
      image: { width: 1, height: 1, data: new Uint8Array([0, 249, 0, 255]) },
      pixelRatio: 1,
    };
    registerGeneratedImage("test-url-pattern-builtin", () => result);
    let finishSvg!: (value: GeneratedImageResult) => void;
    registerGeneratedImage(
      "test-url-pattern-svg",
      () =>
        new Promise((resolve) => {
          finishSvg = resolve;
        }),
    );
    ensureGeneratedImageHandler(map as never);
    ensureGeneratedImageHandler(map as never);
    assert.equal(installations, 1);
    assert.ok(resolveMissing);
    await resolveMissing("unregistered-basemap-image");
    assert.equal(images.has("unregistered-basemap-image"), false);
    await resolveMissing("test-url-pattern-builtin");
    assert.equal(images.get("test-url-pattern-builtin"), result.image);
    const svgReady = resolveMissing("test-url-pattern-svg");
    assert.ok(svgReady instanceof Promise, "MapLibre must be able to await SVG rasterization");
    assert.equal(images.has("test-url-pattern-svg"), false);
    finishSvg(result);
    await svgReady;
    assert.equal(images.get("test-url-pattern-svg"), result.image);
  });

  it("keeps the event-based image path for older GL engines", () => {
    let missing: ((event: { id: string }) => void) | undefined;
    let calls = 0;
    let imageOptions: unknown;
    const images = new Map<string, unknown>();
    const map = {
      on: (_event: string, handler: typeof missing) => {
        missing = handler;
      },
      hasImage: (id: string) => images.has(id),
      addImage: (id: string, image: unknown, options: unknown) => {
        images.set(id, image);
        imageOptions = options;
      },
    };
    const image = { width: 1, height: 1, data: new Uint8Array([0, 249, 0, 255]) };
    registerGeneratedImage("test-legacy-pattern", () => {
      calls += 1;
      return { image, pixelRatio: 2 };
    });
    ensureGeneratedImageHandler(map as never);
    assert.ok(missing);
    missing({ id: "test-legacy-pattern" });
    missing({ id: "test-legacy-pattern" });
    assert.equal(calls, 1);
    assert.equal(images.get("test-legacy-pattern"), image);
    assert.deepEqual(imageOptions, { pixelRatio: 2 });
  });

  it("resolves failed asynchronous factories to a transparent fallback", async () => {
    let resolveMissing: ((id: string) => void | Promise<void>) | undefined;
    const images = new Map<string, unknown>();
    const map = {
      on() {},
      hasImage: (id: string) => images.has(id),
      addImage: (id: string, image: unknown) => images.set(id, image),
      setMissingStyleImageResolver: (resolver: typeof resolveMissing) => {
        resolveMissing = resolver;
      },
    };
    registerGeneratedImage("test-rejected-svg", () => Promise.reject(new Error("invalid SVG")));
    registerGeneratedImage("test-empty-svg", () => Promise.resolve(null));
    ensureGeneratedImageHandler(map as never);
    assert.ok(resolveMissing);
    for (const id of ["test-rejected-svg", "test-empty-svg"]) {
      await resolveMissing(id);
      assert.deepEqual(images.get(id), { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) });
    }
  });

  it("hands non-generated ids to a resolver installed before GeoLibre's", async () => {
    const requested: string[] = [];
    let resolveMissing: ((id: string) => void | Promise<void>) | undefined;
    const images = new Map<string, unknown>();
    const map = {
      on() {},
      hasImage: (id: string) => images.has(id),
      addImage: (id: string, image: unknown) => images.set(id, image),
      _missingStyleImageResolver: (id: string) => {
        requested.push(id);
      },
      setMissingStyleImageResolver(resolver: typeof resolveMissing) {
        resolveMissing = resolver;
      },
    };
    const image = { width: 1, height: 1, data: new Uint8Array([0, 249, 0, 255]) };
    registerGeneratedImage("test-chained-pattern", () => ({ image, pixelRatio: 1 }));
    ensureGeneratedImageHandler(map as never);
    assert.ok(resolveMissing);
    await resolveMissing("app-custom-icon");
    assert.deepEqual(requested, ["app-custom-icon"]);
    await resolveMissing("test-chained-pattern");
    assert.deepEqual(requested, ["app-custom-icon"]);
    assert.equal(images.get("test-chained-pattern"), image);
  });
});
