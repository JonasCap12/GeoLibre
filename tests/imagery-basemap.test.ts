import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ESRI_WORLD_IMAGERY,
  ESRI_WORLD_IMAGERY_ATTRIBUTION,
  ESRI_WORLD_IMAGERY_TILE_URL,
} from "../packages/core/src/imagery-basemaps";
import { createEmptyProject, parseProject, serializeProject } from "../packages/core/src/project";
import { basemapToCesiumImagery } from "../packages/core/src/cesium-imagery";
import { ARCGIS_KEYLESS_BASEMAP_URL, planArcgisBasemap } from "../packages/map/src/arcgis-basemap";
import { resolveMapStyle } from "../packages/map/src/basemap-style";
import { DEFAULT_BASEMAP } from "../packages/core/src/types";
import { REGIONAL_BASEMAPS } from "../packages/core/src/regional-basemaps";
import {
  CHINA_MARKET_BASEMAP_PROVIDERS,
  visibleRegionalBasemapGroups,
  visibleRegionalBasemaps,
  newProjectBasemapStyleUrl,
  withoutChinaMarketBasemaps,
} from "../packages/core/src/basemap-policy";

describe("Esri World Imagery preset", () => {
  it("resolves to a label-free raster style with World Imagery tiles", () => {
    const style = resolveMapStyle(ESRI_WORLD_IMAGERY.styleUrl);
    assert.equal(typeof style, "object");
    if (typeof style === "string") return;
    const source = style.sources["imagery-basemap"];
    assert.ok(source);
    assert.equal(source.type, "raster");
    if (source.type !== "raster") return;
    assert.deepEqual(source.tiles, [ESRI_WORLD_IMAGERY_TILE_URL]);
    assert.equal(source.tileSize, 256);
    assert.equal(source.maxzoom, 19);
    assert.equal(source.attribution, ESRI_WORLD_IMAGERY_ATTRIBUTION);
    assert.match(ESRI_WORLD_IMAGERY_TILE_URL, /\/tile\/\{z\}\/\{y\}\/\{x\}$/);
    assert.equal(style.sources["imagery-basemap-overlay"], undefined);
    assert.equal(
      style.layers.some((layer) => layer.id === "imagery-basemap-overlay"),
      false,
    );
  });

  it("maps to Cesium's existing esri-imagery service", () => {
    const fromPreset = basemapToCesiumImagery(ESRI_WORLD_IMAGERY.styleUrl);
    const fromCatalog = basemapToCesiumImagery(undefined, "esri-imagery");
    assert.deepEqual(fromPreset, fromCatalog);
    assert.deepEqual(fromPreset, {
      kind: "arcgis",
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
    });
  });

  it("maps to the ArcGIS World Imagery tile service", () => {
    assert.deepEqual(planArcgisBasemap(ESRI_WORLD_IMAGERY.styleUrl, undefined, false), {
      kind: "tile-service",
      url: ARCGIS_KEYLESS_BASEMAP_URL,
    });
  });

  it("round-trips through project save and load", () => {
    const project = createEmptyProject("Hanoi", {
      basemapStyleUrl: ESRI_WORLD_IMAGERY.styleUrl,
    });
    const loaded = parseProject(serializeProject(project));
    assert.equal(loaded.basemapStyleUrl, ESRI_WORLD_IMAGERY.styleUrl);
  });
});

describe("hidden basemap regions", () => {
  const china = { VITE_GEOLIBRE_HIDDEN_BASEMAP_REGIONS: "china" };
  const catalog = [
    { id: "amap-street", provider: "amap" },
    { id: "tencent-street", provider: "tencent" },
    { id: "tianditu-vector", provider: "tianditu" },
    { id: "openfreemap-liberty", provider: "openfreemap" },
  ];

  it("leaves the catalog untouched when the switch is unset", () => {
    assert.equal(visibleRegionalBasemaps({}), REGIONAL_BASEMAPS);
    assert.equal(
      visibleRegionalBasemaps({ VITE_GEOLIBRE_HIDDEN_BASEMAP_REGIONS: "   " }),
      REGIONAL_BASEMAPS,
    );
    assert.equal(withoutChinaMarketBasemaps(catalog, {}), catalog);
  });

  it("leaves the catalog untouched for an unknown region name", () => {
    assert.equal(
      visibleRegionalBasemaps({ VITE_GEOLIBRE_HIDDEN_BASEMAP_REGIONS: "mars" }),
      REGIONAL_BASEMAPS,
    );
    assert.equal(
      visibleRegionalBasemaps({ VITE_GEOLIBRE_HIDDEN_BASEMAP_REGIONS: "foo,bar" }),
      REGIONAL_BASEMAPS,
    );
  });

  it("drops China-market entries and the section when china is named", () => {
    const visible = visibleRegionalBasemaps(china);
    assert.equal(
      visibleRegionalBasemaps({ VITE_GEOLIBRE_HIDDEN_BASEMAP_REGIONS: "china,foo" }).some(
        (basemap) => basemap.region === "china",
      ),
      false,
    );
    assert.equal(
      visible.some((basemap) => basemap.region === "china"),
      false,
    );
    assert.equal(visibleRegionalBasemapGroups(china).length, 0);
    assert.deepEqual(
      withoutChinaMarketBasemaps(catalog, china).map((basemap) => basemap.provider),
      ["openfreemap"],
    );
    assert.deepEqual([...CHINA_MARKET_BASEMAP_PROVIDERS], ["amap", "tencent", "tianditu"]);
  });

  it("still draws a saved China sentinel when the catalog hides it", () => {
    const styleUrl = "geolibre://regional-basemap/amap-satellite";
    assert.equal(
      visibleRegionalBasemaps(china).some((basemap) => basemap.styleUrl === styleUrl),
      false,
    );
    const project = createEmptyProject("saved", { basemapStyleUrl: styleUrl });
    const loaded = parseProject(serializeProject(project));
    assert.equal(loaded.basemapStyleUrl, styleUrl);
    const style = resolveMapStyle(loaded.basemapStyleUrl);
    assert.notEqual(style, DEFAULT_BASEMAP);
    assert.equal(typeof style === "object" && style !== null, true);
    if (typeof style !== "object" || style === null) return;
    const source = style.sources["regional-basemap"];
    assert.equal(source?.type, "raster");
  });
});

describe("deployment default basemap", () => {
  it("starts a new project on the named imagery preset", () => {
    assert.equal(
      newProjectBasemapStyleUrl({ VITE_GEOLIBRE_DEFAULT_BASEMAP: "esri-world-imagery" }),
      ESRI_WORLD_IMAGERY.styleUrl,
    );
  });

  it("keeps Liberty when the switch is unset or names something else", () => {
    assert.equal(newProjectBasemapStyleUrl({}), DEFAULT_BASEMAP);
    assert.equal(
      newProjectBasemapStyleUrl({ VITE_GEOLIBRE_DEFAULT_BASEMAP: "   " }),
      DEFAULT_BASEMAP,
    );
    assert.equal(
      newProjectBasemapStyleUrl({ VITE_GEOLIBRE_DEFAULT_BASEMAP: "liberty" }),
      DEFAULT_BASEMAP,
    );
    assert.equal(createEmptyProject("Untitled").basemapStyleUrl, DEFAULT_BASEMAP);
  });

  it("does not rewrite a saved project that omits the field", () => {
    const raw = JSON.parse(serializeProject(createEmptyProject("old"))) as {
      basemapStyleUrl?: string;
    };
    delete raw.basemapStyleUrl;
    assert.equal(parseProject(JSON.stringify(raw)).basemapStyleUrl, DEFAULT_BASEMAP);
  });
});
