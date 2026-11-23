export type NetworkDashboardView = "split" | "report" | "map";
export const NETWORK_VIEW_STORAGE = "geolibre-network-dashboard-view";

/**
 * The view to show: the saved one, or by default the map with the report
 * around it ("split"). Phones have no room for that and get the map alone.
 */
export function dashboardView(saved: unknown, narrow: boolean): NetworkDashboardView {
  if (saved === "report" || saved === "map") return saved;
  return narrow ? "map" : "split";
}
