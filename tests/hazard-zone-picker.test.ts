import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import {
  HAZARD_COLLECTION_FLAG,
  addPickedHazardZone,
  dedicatedHazardLayer,
  hazardZoneEntries,
  migrateLegacyHazardLayer,
  pickExistingHazardZoneAt,
  pickPolygonAt,
  removeHazardZone,
} from "../apps/geolibre-desktop/src/lib/hazard-zone-picker";
import {
  HAZARD_ZONE_FLAG,
  collectHazardZones,
} from "../apps/geolibre-desktop/src/lib/hazard-zones";

function square(min: number, max: number, hole?: [number, number]): Polygon {
  const rings = [
    [
      [min, min],
      [max, min],
      [max, max],
      [min, max],
      [min, min],
    ],
  ];
  if (hole) {
    const [low, high] = hole;
    rings.push([
      [low, low],
      [high, low],
      [high, high],
      [low, high],
      [low, low],
    ]);
  }
  return { type: "Polygon", coordinates: rings };
}

function polygonFeature(
  geometry: Polygon | MultiPolygon,
  id: string,
  properties: Record<string, unknown> = {},
): Feature<Polygon | MultiPolygon> {
  return { type: "Feature", id, geometry, properties };
}

function layer(
  id: string,
  features: Feature[],
  options: { visible?: boolean; hazard?: boolean; dedicated?: boolean } = {},
): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: options.visible ?? true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      ...(options.hazard ? { [HAZARD_ZONE_FLAG]: true } : {}),
      ...(options.dedicated ? { [HAZARD_COLLECTION_FLAG]: true } : {}),
    },
    geojson: { type: "FeatureCollection", features },
  };
}

describe("hazard zone picker", () => {
  it("picks the topmost visible polygon when layers overlap", () => {
    const bottom = layer("bottom", [polygonFeature(square(0, 10), "bottom-feature")]);
    const top = layer("top", [polygonFeature(square(0, 10), "top-feature")]);
    const picked = pickPolygonAt({ lng: 5, lat: 5 }, [bottom, top]);
    assert.equal(picked?.layerId, "top");
    assert.equal(picked?.feature.id, "top-feature");
  });

  it("skips hidden layers and the dedicated hazard layer", () => {
    const visible = layer("visible", [polygonFeature(square(0, 10), "visible-feature")]);
    const hidden = layer("hidden", [polygonFeature(square(0, 10), "hidden-feature")], {
      visible: false,
    });
    const hazard = layer("hazard", [polygonFeature(square(0, 10), "hazard-feature")], {
      hazard: true,
      dedicated: true,
    });
    assert.equal(pickPolygonAt({ lng: 5, lat: 5 }, [visible, hidden, hazard])?.layerId, "visible");
    assert.equal(
      pickExistingHazardZoneAt({ lng: 5, lat: 5 }, [{ ...hazard, visible: false }]),
      null,
    );
  });

  it("respects polygon holes and handles MultiPolygons", () => {
    const holed = layer("holed", [polygonFeature(square(0, 10, [4, 6]), "hole")]);
    assert.equal(pickPolygonAt({ lng: 5, lat: 5 }, [holed]), null);
    assert.equal(pickPolygonAt({ lng: 2, lat: 2 }, [holed])?.feature.id, "hole");

    const multi: MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [square(20, 30).coordinates, square(40, 50).coordinates],
    };
    const multipolygon = layer("multi", [polygonFeature(multi, "multi-feature")]);
    assert.equal(pickPolygonAt({ lng: 45, lat: 45 }, [multipolygon])?.feature.id, "multi-feature");
  });

  it("returns nothing on empty space and ignores non-polygons", () => {
    const mixed = layer("mixed", [
      {
        type: "Feature",
        id: "point",
        geometry: { type: "Point", coordinates: [5, 5] },
        properties: {},
      },
      polygonFeature(square(20, 30), "polygon"),
    ]);
    assert.equal(pickPolygonAt({ lng: 5, lat: 5 }, [mixed]), null);
    assert.equal(pickPolygonAt({ lng: 100, lat: 100 }, [mixed]), null);
  });

  it("creates the hazard layer once and copies a polygon without changing its source", () => {
    const source = layer("Sketches", [
      polygonFeature(square(0, 10), "source-1", { name: "Crane", extra: "untouched" }),
    ]);
    const originalGeoJson = source.geojson;
    const originalGeometry = source.geojson?.features[0].geometry;
    const picked = pickPolygonAt({ lng: 5, lat: 5 }, [source]);
    assert.ok(picked);

    const first = addPickedHazardZone([source], picked, {
      hazardLayerId: "hazard-layer",
      zoneFeatureId: "zone-1",
    });
    const second = addPickedHazardZone(first.layers, picked, {
      hazardLayerId: "unused-layer",
      zoneFeatureId: "zone-2",
    });

    assert.equal(second.layers.filter((entry) => dedicatedHazardLayer([entry])).length, 1);
    assert.equal(dedicatedHazardLayer(second.layers)?.geojson?.features.length, 2);
    assert.equal(source.geojson, originalGeoJson);
    assert.equal(source.geojson?.features[0].geometry, originalGeometry);
    const copied = dedicatedHazardLayer(first.layers)?.geojson?.features[0];
    assert.notEqual(copied?.geometry, originalGeometry);
    assert.deepEqual(copied?.properties, {
      ten: "Crane",
      muc: "nguy_hiem",
      nguon_lop: "Sketches",
      nguon_id: "source-1",
    });
  });

  it("removes a zone only from the dedicated layer", () => {
    const source = layer("source", [polygonFeature(square(0, 10), "source-1")]);
    const picked = pickPolygonAt({ lng: 5, lat: 5 }, [source]);
    assert.ok(picked);
    const added = addPickedHazardZone([source], picked, {
      hazardLayerId: "hazard-layer",
      zoneFeatureId: "zone-1",
    });
    const removed = removeHazardZone(added.layers, "zone-1");
    assert.ok(removed);
    assert.equal(removed.layers[0], source);
    assert.equal(dedicatedHazardLayer(removed.layers)?.geojson?.features.length, 0);
  });

  it("keeps legacy zones active and migrates copies while clearing the old flag", () => {
    const legacy = layer(
      "Sketches",
      [polygonFeature(square(0, 10), "legacy-1", { ten: "Pit", muc: "canh_bao" })],
      { hazard: true },
    );
    assert.equal(collectHazardZones([legacy]).length, 1);

    let nextId = 0;
    const migrated = migrateLegacyHazardLayer([legacy], legacy.id, {
      hazardLayerId: "hazard-layer",
      nextZoneFeatureId: () => `migrated-${++nextId}`,
    });
    assert.ok(migrated);
    const old = migrated.layers.find((entry) => entry.id === legacy.id);
    assert.equal(old?.metadata[HAZARD_ZONE_FLAG], undefined);
    assert.equal(old?.geojson, legacy.geojson);
    assert.equal(collectHazardZones(migrated.layers).length, 1);
    assert.deepEqual(hazardZoneEntries(migrated.layers)[0], {
      featureKey: "migrated-1",
      name: "Pit",
      level: "canh_bao",
      sourceLayerName: "Sketches",
      geometry: square(0, 10),
    });
  });
});
