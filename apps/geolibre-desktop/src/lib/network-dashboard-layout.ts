export type NetworkDashboardView = "split" | "report" | "map";
export const NETWORK_VIEW_STORAGE = "geolibre-network-dashboard-view";
export const NETWORK_RATIO_STORAGE = "geolibre-network-dashboard-ratio";

export function dashboardView(saved: unknown, narrow: boolean): NetworkDashboardView {
  if (saved === "report" || saved === "map") return saved;
  return narrow ? "map" : "split";
}

export function clampDashboardRatio(ratio: number): number {
  return Math.max(35, Math.min(80, ratio));
}

export function dashboardRatio(saved: string | null): number | null {
  if (!saved?.trim()) return null;
  const value = Number(saved);
  return Number.isFinite(value) ? clampDashboardRatio(value) : null;
}

export function dashboardPointerRatio(clientX: number, width: number, rtl: boolean): number {
  return clampDashboardRatio(((rtl ? width - clientX : clientX) / width) * 100);
}

/** A screen rectangle (a DOMRect's edges). */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** MapLibre camera padding, in pixels from each edge of the map. */
export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Below this many pixels the open area is too small to frame anything in. */
const MIN_OPEN_PX = 120;

/**
 * Padding that frames the map's content in the part the floating report does
 * not cover: beside it or below it, whichever open area is larger. The report
 * sits in the map's start-top corner (the right side in an RTL layout).
 */
export function paddingBesideBoard(
  map: ScreenBox,
  board: ScreenBox | null,
  rtl: boolean,
  pad = 60,
): MapPadding {
  const even = { top: pad, right: pad, bottom: pad, left: pad };
  if (!board) return even;
  const mapWidth = map.right - map.left;
  const mapHeight = map.bottom - map.top;
  const coveredWidth = Math.max(0, rtl ? map.right - board.left : board.right - map.left);
  const coveredHeight = Math.max(0, board.bottom - map.top);
  if (coveredWidth <= 0 || coveredHeight <= 0) return even;
  const besideWidth = mapWidth - coveredWidth;
  const belowHeight = mapHeight - coveredHeight;
  const besideArea = besideWidth * mapHeight;
  const belowArea = belowHeight * mapWidth;
  if (besideWidth >= MIN_OPEN_PX && besideArea >= belowArea) {
    return rtl ? { ...even, right: coveredWidth + pad } : { ...even, left: coveredWidth + pad };
  }
  if (belowHeight >= MIN_OPEN_PX) return { ...even, top: coveredHeight + pad };
  return even;
}
