/**
 * Keyless satellite imagery for the MapLibre basemap picker.
 *
 * A sibling of {@link ./regional-basemaps} rather than another region in it:
 * that catalog and its "Regional" section exist so users inside mainland China
 * can reach a basemap, and its region type is only `"china"`. This preset is
 * global imagery, so it keeps its own sentinel prefix and its own picker
 * section. The sentinel still expands the same way — a raster style, a Cesium
 * imagery provider, an ArcGIS basemap — because `resolveMapStyle` and
 * `basemapToCesiumImagery` look it up beside the regional ones.
 */

/**
 * The credit MapLibre's attribution control shows for Esri World Imagery.
 * The same string the Esri Wayback plugin applies to its raster source
 * (`maplibre-esri-wayback.ts`); one wording, not a second credit line.
 */
export const ESRI_WORLD_IMAGERY_ATTRIBUTION =
  'Powered by <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a> — Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/** World Imagery tile template. Row order is `{z}/{y}/{x}`, tile size 256. */
export const ESRI_WORLD_IMAGERY_TILE_URL =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export const IMAGERY_BASEMAP_SENTINEL_PREFIX = "geolibre://imagery-basemap/";

/**
 * A keyless imagery basemap. Imagery only: no reference or label overlay,
 * because a foreign label layer can name disputed islands wrongly.
 */
export interface ImageryBasemap {
  id: string;
  /** `t()` key for the picker button. The id stays stable in saved projects. */
  labelKey: "basemapPicker.esriWorldImagery";
  styleUrl: string;
  tileUrl: string;
  /**
   * Max native zoom. The Cesium and ArcGIS World Imagery entries name the
   * service and leave the level to the server, so this is 19 and MapLibre
   * overzooms past it.
   */
  maxZoom: number;
  attribution: string;
  /**
   * `service` on the existing `esri-imagery` row of `CESIUM_BASEMAPS`. The
   * globe and the ArcGIS engine both turn that into the World Imagery MapServer.
   */
  cesiumService: "World_Imagery";
}

const sentinel = (id: string) => `${IMAGERY_BASEMAP_SENTINEL_PREFIX}${id}`;

export const ESRI_WORLD_IMAGERY: ImageryBasemap = {
  id: "esri-world-imagery",
  labelKey: "basemapPicker.esriWorldImagery",
  styleUrl: sentinel("esri-world-imagery"),
  tileUrl: ESRI_WORLD_IMAGERY_TILE_URL,
  maxZoom: 19,
  attribution: ESRI_WORLD_IMAGERY_ATTRIBUTION,
  cesiumService: "World_Imagery",
};

export const IMAGERY_BASEMAPS: readonly ImageryBasemap[] = [ESRI_WORLD_IMAGERY];

export function getImageryBasemapByStyleUrl(
  styleUrl: string | undefined,
): ImageryBasemap | undefined {
  if (!styleUrl) return undefined;
  return IMAGERY_BASEMAPS.find((basemap) => basemap.styleUrl === styleUrl);
}

export function getImageryBasemapById(id: string | undefined): ImageryBasemap | undefined {
  if (!id) return undefined;
  return IMAGERY_BASEMAPS.find((basemap) => basemap.id === id);
}

export function isImageryBasemapSentinel(styleUrl: string | undefined): boolean {
  return Boolean(styleUrl?.startsWith(IMAGERY_BASEMAP_SENTINEL_PREFIX));
}
