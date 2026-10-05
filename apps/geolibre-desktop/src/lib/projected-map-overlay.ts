import type { MapEngine, MapExtent } from "@geolibre/map";

export type ProjectedOverlayAnchor = "top-left" | "bottom";

export interface ProjectedElementHandle {
  setCoordinate(coordinate: [number, number]): void;
  remove(): void;
}

export interface ProjectedExtentHandle {
  setExtent(extent: MapExtent): void;
  setColor(color: string): void;
  remove(): void;
}

interface SharedResizeObserver {
  observer: ResizeObserver;
  callbacks: Set<() => void>;
}

const resizeObservers = new WeakMap<HTMLElement, SharedResizeObserver>();

/**
 * Fork: paint each overlay at most once per animation frame, and draw every
 * remote viewport into one SVG. Upstream runs `render()` from each MapLibre
 * "move" listener and from every presence update, with a separate full-size
 * SVG per viewport. In a live session that made zoom janky — projections and
 * DOM writes ran once per event, and the map composited N extra layers. A
 * coordinate or extent equal to the one already shown schedules nothing.
 * Keep this if a later upstream merge drops it; the public handles are unchanged.
 */
const dirtyPaints = new Set<() => void>();
let frameQueued = false;

function scheduleOverlayPaint(paint: () => void): void {
  dirtyPaints.add(paint);
  if (frameQueued) return;
  frameQueued = true;
  const flush = () => {
    frameQueued = false;
    const batch = [...dirtyPaints];
    dirtyPaints.clear();
    for (const pending of batch) pending();
  };
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(flush);
    return;
  }
  setTimeout(flush, 0);
}

function cancelOverlayPaint(paint: () => void): void {
  dirtyPaints.delete(paint);
}

function observeContainerResize(container: HTMLElement, callback: () => void): () => void {
  let shared = resizeObservers.get(container);
  if (!shared) {
    const callbacks = new Set<() => void>();
    const observer = new ResizeObserver(() => {
      callbacks.forEach((render) => render());
    });
    shared = { observer, callbacks };
    resizeObservers.set(container, shared);
    observer.observe(container);
  }
  shared.callbacks.add(callback);

  return () => {
    shared.callbacks.delete(callback);
    if (shared.callbacks.size === 0) {
      shared.observer.disconnect();
      resizeObservers.delete(container);
    }
  };
}

/** Mount a DOM element at a geographic coordinate on any rendering engine. */
export function mountProjectedElement(
  engine: MapEngine,
  element: HTMLElement,
  coordinate: [number, number],
  anchor: ProjectedOverlayAnchor,
): ProjectedElementHandle {
  const surface = engine.getRenderSurface();
  if (!surface) return { setCoordinate: () => {}, remove: () => {} };
  let currentCoordinate = coordinate;
  const container = surface.getContainer();
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = "0";
  element.style.zIndex ||= "10";
  container.appendChild(element);

  let removed = false;
  const render = () => {
    if (removed) return;
    try {
      const point = surface.project(currentCoordinate);
      const anchorTransform = anchor === "bottom" ? " translate(-50%, -100%)" : "";
      element.style.transform = `translate(${point.x}px, ${point.y}px)${anchorTransform}`;
      element.style.display = "";
    } catch {
      element.style.display = "none";
    }
  };
  const schedule = () => scheduleOverlayPaint(render);
  const detachMove = engine.onCameraMove(schedule);
  const detachIdle = engine.onCameraIdle(schedule);
  const detachResize = observeContainerResize(container, schedule);
  schedule();

  return {
    setCoordinate(next) {
      if (next[0] === currentCoordinate[0] && next[1] === currentCoordinate[1]) return;
      currentCoordinate = next;
      schedule();
    },
    remove() {
      removed = true;
      cancelOverlayPaint(render);
      detachMove();
      detachIdle();
      detachResize();
      element.remove();
    },
  };
}

interface ExtentEntry {
  extent: MapExtent;
  polygon: SVGPolygonElement;
  paint: () => void;
}

interface SharedExtentLayer {
  svg: SVGSVGElement;
  entries: Set<ExtentEntry>;
  detachMove: () => void;
  detachIdle: () => void;
  detachResize: () => void;
}

const extentLayers = new WeakMap<HTMLElement, SharedExtentLayer>();

function sameExtent(a: MapExtent, b: MapExtent): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function acquireExtentLayer(engine: MapEngine, container: HTMLElement): SharedExtentLayer {
  const existing = extentLayers.get(container);
  if (existing) return existing;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("geolibre-collab-viewport");
  svg.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:9;overflow:hidden;";
  const entries = new Set<ExtentEntry>();
  const scheduleAll = () => {
    for (const entry of entries) scheduleOverlayPaint(entry.paint);
  };
  const layer: SharedExtentLayer = {
    svg,
    entries,
    detachMove: engine.onCameraMove(scheduleAll),
    detachIdle: engine.onCameraIdle(scheduleAll),
    detachResize: observeContainerResize(container, scheduleAll),
  };
  extentLayers.set(container, layer);
  container.appendChild(svg);
  return layer;
}

function releaseExtentEntry(
  container: HTMLElement,
  layer: SharedExtentLayer,
  entry: ExtentEntry,
): void {
  cancelOverlayPaint(entry.paint);
  layer.entries.delete(entry);
  entry.polygon.remove();
  if (layer.entries.size > 0) return;
  layer.detachMove();
  layer.detachIdle();
  layer.detachResize();
  layer.svg.remove();
  extentLayers.delete(container);
}

/** Draw a participant viewport as a projected, colored outline. */
export function mountProjectedExtent(
  engine: MapEngine,
  extent: MapExtent,
  color: string,
): ProjectedExtentHandle {
  const surface = engine.getRenderSurface();
  if (!surface) return { setExtent: () => {}, setColor: () => {}, remove: () => {} };
  const container = surface.getContainer();
  const layer = acquireExtentLayer(engine, container);
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("fill", "none");
  polygon.setAttribute("stroke", color);
  polygon.setAttribute("stroke-width", "2");
  polygon.setAttribute("stroke-dasharray", "4 2");
  polygon.setAttribute("stroke-opacity", "0.8");
  layer.svg.appendChild(polygon);

  const entry: ExtentEntry = { extent, polygon, paint: () => {} };
  let removed = false;
  entry.paint = () => {
    if (removed) return;
    try {
      const [west, south, rawEast, north] = entry.extent;
      const east = rawEast < west ? rawEast + 360 : rawEast;
      const points = [
        surface.project([west, south]),
        surface.project([east, south]),
        surface.project([east, north]),
        surface.project([west, north]),
      ];
      polygon.setAttribute("points", points.map(({ x, y }) => `${x},${y}`).join(" "));
      polygon.style.display = "";
    } catch {
      polygon.style.display = "none";
    }
  };
  layer.entries.add(entry);
  scheduleOverlayPaint(entry.paint);

  return {
    setExtent(next) {
      if (sameExtent(entry.extent, next)) return;
      entry.extent = next;
      scheduleOverlayPaint(entry.paint);
    },
    setColor(next) {
      polygon.setAttribute("stroke", next);
    },
    remove() {
      removed = true;
      releaseExtentEntry(container, layer, entry);
    },
  };
}
