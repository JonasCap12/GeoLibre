import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Must precede the @osmix imports, as in osm-pbf.ts.
import "../apps/geolibre-desktop/src/lib/osm-shared-array-buffer-shim";
import { Osm } from "@osmix/core";
// The upstream original, still installed as a dependency of the `osmix`
// dev dependency. The app uses the port; this keeps the two in step.
import { osmEntityToGeoJSONFeature as upstream } from "@osmix/geojson";
import { osmEntityToGeoJSONFeature } from "../apps/geolibre-desktop/src/lib/osm-entity-feature";

type Member = { type: "node" | "way" | "relation"; ref: number; role: string };

/** An index with every geometry kind the conversion distinguishes. */
function sampleOsm(): Osm {
  const osm = new Osm({ id: "entity-feature" });
  const positions: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [5, 5],
    [6, 5],
    [6, 6],
    [5, 6],
    [9, 9],
    [10, 10],
  ];
  positions.forEach(([lon, lat], i) =>
    osm.nodes.addNode({ id: i + 1, lon, lat, tags: i === 0 ? { amenity: "cafe" } : undefined }),
  );
  osm.nodes.buildIndex();

  osm.ways.addWay({ id: 10, refs: [1, 2], tags: { highway: "path" } }); // line
  osm.ways.addWay({ id: 11, refs: [1, 2, 3, 4, 1], tags: { building: "yes" } }); // area
  osm.ways.addWay({ id: 12, refs: [5, 6, 7, 8, 5] }); // second closed ring
  osm.ways.addWay({ id: 13, refs: [9, 10] }); // disjoint line

  const way = (ref: number, role = "outer"): Member => ({ type: "way", ref, role });
  const node = (ref: number): Member => ({ type: "node", ref, role: "" });
  const relations: [number, Member[], Record<string, string>][] = [
    [100, [way(11)], { type: "multipolygon", landuse: "grass" }],
    [101, [way(11), way(12)], { type: "multipolygon", landuse: "forest" }],
    [102, [way(10, "")], { type: "route", route: "bus" }],
    [103, [way(10, ""), way(13, "")], { type: "route", route: "bus" }],
    [104, [node(1)], { type: "multipoint" }],
    [105, [node(1), node(9)], { type: "multipoint" }],
    [106, [way(10, "from"), node(2)], { type: "restriction" }],
    [107, [{ type: "relation", ref: 100, role: "" }], { name: "super" }],
    [108, [way(999)], { type: "multipolygon" }], // member missing from the extract
  ];
  for (const [id, members, tags] of relations) osm.relations.addRelation({ id, members, tags });
  osm.buildIndexes();
  return osm;
}

describe("OSM entity to GeoJSON feature (port of @osmix/geojson)", () => {
  it("matches the upstream function for every node, way and relation", () => {
    const osm = sampleOsm();
    const entities = [...osm.nodes, ...osm.ways, ...osm.relations];
    const types = new Set<string>();
    for (const entity of entities) {
      const feature = osmEntityToGeoJSONFeature(osm, entity);
      assert.deepEqual(feature, upstream(osm, entity), `entity ${entity.id}`);
      types.add(feature.geometry.type);
    }
    // The sample really reaches every branch, so a match means something.
    assert.deepEqual([...types].sort(), [
      "GeometryCollection",
      "LineString",
      "MultiLineString",
      "MultiPoint",
      "MultiPolygon",
      "Point",
      "Polygon",
    ]);
  });

  it("keeps the OSM id, entity type and tags as properties", () => {
    const osm = sampleOsm();
    const building = osm.ways.getById(11);
    assert.ok(building);
    assert.deepEqual(osmEntityToGeoJSONFeature(osm, building).properties, {
      id: 11,
      type: "way",
      building: "yes",
    });
  });

  it("throws, like upstream, when a way references a missing node", () => {
    const osm = new Osm({ id: "broken" });
    osm.nodes.addNode({ id: 1, lon: 0, lat: 0 });
    osm.nodes.buildIndex();
    osm.ways.addWay({ id: 10, refs: [1, 2], tags: { highway: "path" } });
    osm.buildIndexes();
    const way = osm.ways.getById(10);
    assert.ok(way);
    assert.throws(() => osmEntityToGeoJSONFeature(osm, way), /Node 2 not found/);
    assert.throws(() => upstream(osm, way), /Node 2 not found/);
  });
});
