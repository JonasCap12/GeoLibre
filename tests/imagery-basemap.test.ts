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
