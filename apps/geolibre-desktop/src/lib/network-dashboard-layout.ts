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
