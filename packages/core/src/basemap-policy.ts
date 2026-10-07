/**
 * Deployment policy for which basemaps a build offers.
 *
 * Read from {@link getBuildEnvironment}, never {@link getRuntimeEnvironment}:
 * a `.geolibre.json` someone opens must not be able to put a hidden catalog
 * back. Unset (or an unknown region name) leaves the catalogs unchanged.
 *
 * Hiding a region removes it from the pickers and from the Basemaps control.
 * A project that already stores that sentinel still resolves and draws. The
 * switch is catalog policy, not a ban on opening a saved file, so
 * `getRegionalBasemapByStyleUrl` and `resolveMapStyle` do not consult it.
 */

import { getBuildEnvironment } from "./runtime-env";
import {
  REGIONAL_BASEMAP_GROUPS,
  REGIONAL_BASEMAPS,
  type RegionalBasemap,
  type RegionalBasemapRegionId,
} from "./regional-basemaps";

export const HIDDEN_BASEMAP_REGIONS_ENV = "VITE_GEOLIBRE_HIDDEN_BASEMAP_REGIONS";

/**
 * Providers in `maplibre-gl-basemap-control`'s default catalog that serve
 * China-market tiles. Listed from the package (0.14.4): amap, tencent,
 * tianditu. The package has no Baidu entries.
 */
export const CHINA_MARKET_BASEMAP_PROVIDERS = ["amap", "tencent", "tianditu"] as const;

const KNOWN_REGIONS = new Set<string>(["china"]);

function readEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  return env ?? getBuildEnvironment();
}

/** Region ids named by the build switch that this catalog actually has. */
export function hiddenBasemapRegionIds(
  env?: Record<string, string | undefined>,
): ReadonlySet<string> {
  const raw = readEnv(env)[HIDDEN_BASEMAP_REGIONS_ENV];
  if (!raw?.trim()) return new Set();
  const known = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => KNOWN_REGIONS.has(part));
  return new Set(known);
}

/**
 * Regional basemaps the pickers should list. The same array as
 * {@link REGIONAL_BASEMAPS} when nothing known is hidden, so an unset or
 * unknown switch does not copy the catalog.
 */
export function visibleRegionalBasemaps(
  env?: Record<string, string | undefined>,
): readonly RegionalBasemap[] {
  const hidden = hiddenBasemapRegionIds(env);
  if (hidden.size === 0) return REGIONAL_BASEMAPS;
  return REGIONAL_BASEMAPS.filter((basemap) => !hidden.has(basemap.region));
}

/**
 * Regional groups for the picker section. Empty when every group is hidden,
 * so the section heading and its region note are omitted entirely.
 */
export function visibleRegionalBasemapGroups(env?: Record<string, string | undefined>): readonly {
  id: RegionalBasemapRegionId;
  basemaps: readonly RegionalBasemap[];
}[] {
  const hidden = hiddenBasemapRegionIds(env);
  if (hidden.size === 0) return REGIONAL_BASEMAP_GROUPS;
  return REGIONAL_BASEMAP_GROUPS.map((group) => ({
    ...group,
    basemaps: group.basemaps.filter((basemap) => !hidden.has(basemap.region)),
  })).filter((group) => group.basemaps.length > 0);
}

/** Whether the Basemaps control should drop China-market providers. */
export function chinaMarketBasemapProvidersHidden(
  env?: Record<string, string | undefined>,
): boolean {
  return hiddenBasemapRegionIds(env).has("china");
}

/**
 * Drop China-market providers from a control catalog. Returns the same array
 * when the switch does not name `china`.
 */
export function withoutChinaMarketBasemaps<T extends { provider: string }>(
  basemaps: readonly T[],
  env?: Record<string, string | undefined>,
): readonly T[] {
  if (!chinaMarketBasemapProvidersHidden(env)) return basemaps;
  const hidden = new Set<string>(CHINA_MARKET_BASEMAP_PROVIDERS);
  return basemaps.filter((basemap) => !hidden.has(basemap.provider));
}
