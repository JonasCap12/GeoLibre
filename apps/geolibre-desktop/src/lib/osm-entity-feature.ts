// OSM entity → GeoJSON feature, ported from `osmEntityToGeoJSONFeature` in
// @osmix/geojson 0.0.17 (MIT, the osmix authors), using the @osmix/geo and
// @osmix/types helpers it called.
//
// Why a port instead of the package: @osmix/geojson depends on
// @placemarkio/geojson-rewind, which publishes @changesets/cli as a runtime
// dependency. That drags micromatch → picomatch (GHSA-fc5q-39xc-vjpf, a ReDoS
// with no patched release) into the production tree and fails the npm audit
// gate. The rewind package only serves the GeoJSON → OSM direction, which the
// app does not use. tests/osm-entity-feature.test.ts checks this port against
// the upstream function, so drift shows up as a failing test.
import type { Osm } from "@osmix/core";
import { buildRelationRings } from "@osmix/geo/relation-multipolygon";
import { wayIsArea } from "@osmix/geo/way-is-area";
import type { OsmEntity, OsmNode, OsmRelation, OsmWay } from "@osmix/types";
import {
  buildRelationLineStrings,
  collectRelationPoints,
  getRelationKind,
} from "@osmix/types/relation-kind";
import { isNode, isRelation, isWay } from "@osmix/types/utils";
import type { Feature, Geometry } from "geojson";

/** The parts of an `Osm` index the conversion reads. */
export type OsmLookup = {
  nodes: Pick<Osm["nodes"], "getNodeLonLat">;
  ways: Pick<Osm["ways"], "getById">;
};

type EntityType = "node" | "way" | "relation";

function toFeature(entity: OsmEntity, type: EntityType, geometry: Geometry): Feature {
  return {
    type: "Feature",
    id: entity.id,
    geometry,
    properties: { id: entity.id, type, ...entity.info, ...entity.tags },
  };
}

/**
 * One part becomes the single geometry, any other count the multi geometry
 * (an empty multi geometry when nothing resolved), as upstream does.
 */
function singleOrMulti(
  single: "Point" | "LineString" | "Polygon",
  multi: "MultiPoint" | "MultiLineString" | "MultiPolygon",
  parts: unknown[],
): Geometry {
  return (
    parts.length === 1
      ? { type: single, coordinates: parts[0] }
      : { type: multi, coordinates: parts }
  ) as Geometry;
}

const EMPTY_COLLECTION: Geometry = { type: "GeometryCollection", geometries: [] };

function nodeToFeature(node: OsmNode): Feature {
  return toFeature(node, "node", { type: "Point", coordinates: [node.lon, node.lat] });
}

function wayToFeature(osm: OsmLookup, way: OsmWay): Feature {
  const coordinates = way.refs.map((ref) => {
    const position = osm.nodes.getNodeLonLat({ id: ref });
    if (!position) throw Error(`Node ${ref} not found for way geometry`);
    return position;
  });
  return toFeature(
    way,
    "way",
    wayIsArea(way)
      ? { type: "Polygon", coordinates: [coordinates] }
      : { type: "LineString", coordinates },
  );
}

function relationGeometry(osm: OsmLookup, relation: OsmRelation): Geometry {
  const nodePosition = (id: number): [number, number] | undefined => {
    const position = osm.nodes.getNodeLonLat({ id });
    return position ? [position[0], position[1]] : undefined;
  };
  const getWay = (id: number) => osm.ways.getById(id);

  // The kinds are exhaustive, so upstream's fallback after them never runs.
  switch (getRelationKind(relation)) {
    case "area":
      return singleOrMulti(
        "Polygon",
        "MultiPolygon",
        buildRelationRings(relation, getWay, nodePosition),
      );
    case "line":
      return singleOrMulti(
        "LineString",
        "MultiLineString",
        buildRelationLineStrings(relation, getWay, nodePosition),
      );
    case "point":
      return singleOrMulti("Point", "MultiPoint", collectRelationPoints(relation, nodePosition));
    case "logic":
    case "super":
      return EMPTY_COLLECTION;
  }
}

/** Convert any OSM entity to a GeoJSON feature, resolving coordinates through `osm`. */
export function osmEntityToGeoJSONFeature(osm: OsmLookup, entity: OsmEntity): Feature {
  if (isNode(entity)) return nodeToFeature(entity);
  if (isWay(entity)) return wayToFeature(osm, entity);
  if (isRelation(entity)) return toFeature(entity, "relation", relationGeometry(osm, entity));
  throw new Error("Unknown entity type");
}
