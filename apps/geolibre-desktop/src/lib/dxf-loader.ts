/**
 * Read an AutoCAD DXF in pure JavaScript, without GDAL.
 *
 * The DuckDB-WASM path (`readCadLayers` / `loadDuckDbVectorFile`) is the
 * primary reader and stays so: it handles DWG, resolves the drawing's own
 * metadata, and shares the reprojection path. But the GDAL 3.8.5 that DuckDB's
 * spatial extension bundles has a DXF driver that fails on some drawings'
 * `BLOCKS` section — silently, reporting **zero layers** rather than an error —
 * and that version is pinned inside the extension, so it cannot be upgraded
 * from here. Large civil-engineering drawings hit this routinely.
 *
 * This module is the fallback for exactly that case. It parses the DXF with
 * `dxf-parser` (no WASM, no 32-bit heap) and tessellates the analytic curves
 * itself, so a drawing GDAL rejects still reaches the map.
 *
 * Two deliberate differences from the GDAL path:
 *
 * - **CAD layers are selectable.** GDAL exposes one OGR layer (`entities`) and
 *   puts the CAD layer in an attribute. Here each CAD layer can be loaded on
 *   its own, which is what makes a 45 MB drawing usable in a browser tab.
 * - **Geometry is 2D.** Elevations are dropped; the map renders in plan.
 *
 * Output is in the drawing's own coordinates — DXF stores no CRS — so callers
 * hand the result to `reprojectFeatureCollectionToWgs84` with the CRS the user
 * declared, exactly as the GDAL path does.
 */

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { isBinaryDxf, readDxfCodepage, recodeCadString } from "./cad-encoding";
import { sampleArc, sampleBulge, sampleEllipse, sampleSpline, type Vec2 } from "./dxf-geometry";

/** Sentinel layer name meaning "every CAD layer at once". */
export const ALL_LAYERS = "";

/**
 * Hard ceiling on emitted features.
 *
 * A malformed drawing can nest blocks so that expansion grows without bound.
 * Failing loudly at a number no real drawing reaches beats freezing the tab.
 */
const MAX_FEATURES = 500_000;
/** Deepest block nesting followed before a drawing is judged self-referential. */
const MAX_BLOCK_DEPTH = 8;

/** One CAD layer, for the Add Data layer picker. */
export interface DxfLayerInfo {
  /** The CAD layer name, passed back to {@link DxfDrawing.toFeatureCollection}. */
  name: string;
  /** How many features the layer yields once blocks are expanded. */
  featureCount: number;
  /** A human-readable geometry summary, or "Mixed". */
  geometryType: string;
}

/** A parsed drawing, kept so the picker and the load share one parse. */
export interface DxfDrawing {
  /** Every CAD layer that produced geometry, busiest first. */
  layers: DxfLayerInfo[];
  /** Total features across all layers. */
  featureCount: number;
  /** The codepage used to decode text, for diagnostics. */
  codepage: string | null;
  /**
   * Build a FeatureCollection in the drawing's own coordinates.
   *
   * @param layer A CAD layer name, or {@link ALL_LAYERS} for the whole drawing.
   */
  toFeatureCollection(layer: string): FeatureCollection;
}

/** A 2x3 affine transform `[a, b, c, d, e, f]`: `x' = ax + cy + e`. */
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Apply `m` to `point`. */
function transform(m: Matrix, value: Vec2): Position {
  return [m[0] * value.x + m[2] * value.y + m[4], m[1] * value.x + m[3] * value.y + m[5]];
}

/** Compose two transforms so `outer` is applied after `inner`. */
function compose(outer: Matrix, inner: Matrix): Matrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

/**
 * `dxf-parser` types entities loosely and their shape varies by type, so they
 * are read through this index signature with per-field guards rather than a
 * cast that would claim more than the parser guarantees.
 */
interface RawEntity {
  type?: string;
  layer?: string;
  handle?: string;
  [key: string]: unknown;
}

/** A finite planar point, or null when the field is missing or malformed. */
function point(value: unknown): Vec2 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { x?: unknown; y?: unknown };
  const x = typeof candidate.x === "number" ? candidate.x : NaN;
  const y = typeof candidate.y === "number" ? candidate.y : NaN;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Read an array of points, dropping any entry that is not usable. */
function points(value: unknown): Vec2[] {
  if (!Array.isArray(value)) return [];
  const result: Vec2[] = [];
  for (const entry of value) {
    const parsed = point(entry);
    if (parsed) result.push(parsed);
  }
  return result;
}

/** A finite number, or `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Build the transform an INSERT applies to its block's contents.
 *
 * The block's base point is the origin its geometry is drawn around, so it is
 * subtracted before scaling and rotation and the insertion point added after —
 * otherwise a block whose base point is not (0, 0) lands offset by that base
 * point, the classic "symbols scattered across the drawing" bug.
 */
function insertMatrix(insert: RawEntity, base: Vec2): Matrix {
  const rotation = num(insert.rotation, 0) * (Math.PI / 180);
  // A zero or missing scale would collapse the block to a point; treat it as 1.
  const scaleX = num(insert.xScale, 1) || 1;
  const scaleY = num(insert.yScale, 1) || 1;
  const position = point(insert.position) ?? { x: 0, y: 0 };
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const a = scaleX * cos;
  const b = scaleX * sin;
  const c = -scaleY * sin;
  const d = scaleY * cos;
  return [
    a,
    b,
    c,
    d,
    position.x - (a * base.x + c * base.y),
    position.y - (b * base.x + d * base.y),
  ];
}

/**
 * Expand a polyline's vertices, turning every bulged edge into an arc.
 *
 * @param vertices Vertices, each optionally carrying a `bulge`.
 * @param closed Whether the polyline closes back onto its first vertex.
 */
function polylinePoints(vertices: unknown, closed: boolean): Vec2[] {
  if (!Array.isArray(vertices) || vertices.length === 0) return [];
  const result: Vec2[] = [];

  const at = (index: number): Vec2 | null => point(vertices[index]);
  const bulgeAt = (index: number): number => {
    const vertex = vertices[index] as { bulge?: unknown } | undefined;
    return num(vertex?.bulge, 0);
  };

  const edges = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < edges; i += 1) {
    const from = at(i);
    const to = at((i + 1) % vertices.length);
    if (!from || !to) continue;

    const bulge = bulgeAt(i);
    if (bulge === 0) {
      if (result.length === 0) result.push(from);
      result.push(to);
      continue;
    }
    const arc = sampleBulge(from, to, bulge);
    // The arc repeats the previous vertex; drop it so the line has no duplicate.
    result.push(...(result.length === 0 ? arc : arc.slice(1)));
  }

  if (result.length === 0) {
    const only = at(0);
    if (only) result.push(only);
  }
  return result;
}

/** Local-space geometry of a single entity, before any block transform. */
interface LocalGeometry {
  kind: "line" | "polygon" | "point" | "multipolygon";
  points: Vec2[];
  /** Face rings, for `multipolygon` only. `points` stays empty for that kind. */
  rings?: Vec2[][];
}

/**
 * Faces of a polyface mesh, or null when the entity is not one.
 *
 * A polyface-mesh POLYLINE mixes two kinds of VERTEX in one list. Some carry
 * coordinates; the rest are *face records*, which carry no position at all —
 * their `faceA`..`faceD` are 1-based indices into the coordinate vertices, and
 * a negative index only marks that edge invisible. dxf-parser reports those
 * records with `x = y = 0`, so reading the list as a path draws a line from
 * the drawing to the coordinate origin and back for every face.
 *
 * That is not a theoretical concern: it is what stretched a surveyed alignment
 * in Vietnam across the South China Sea to the equator, because the origin of
 * a VN-2000 projection reprojects to roughly the latitude of Singapore.
 *
 * @param entity - The POLYLINE to inspect.
 * @returns One ring per face, or null when this is an ordinary polyline.
 */
function polyfaceMeshRings(entity: RawEntity): Vec2[][] | null {
  const vertices = entity.vertices;
  if (entity.type !== "POLYLINE" || !Array.isArray(vertices)) return null;

  const isFaceRecord = (vertex: unknown): boolean =>
    typeof vertex === "object" && vertex !== null && "faceA" in vertex;

  const corners: Vec2[] = [];
  const faces: RawEntity[] = [];
  for (const vertex of vertices) {
    if (isFaceRecord(vertex)) {
      faces.push(vertex as RawEntity);
      continue;
    }
    const parsed = point(vertex);
    // Index positions must survive a malformed vertex, so a hole is kept
    // rather than collapsing the list and shifting every later face's indices.
    corners.push(parsed ?? { x: NaN, y: NaN });
  }
  if (faces.length === 0) return null;

  const rings: Vec2[][] = [];
  for (const face of faces) {
    const ring: Vec2[] = [];
    for (const key of ["faceA", "faceB", "faceC", "faceD"] as const) {
      // A negative index means "edge invisible", not "different vertex"; zero
      // (or absent) means the face has fewer than four corners.
      const index = Math.abs(num(face[key], 0));
      if (index === 0) continue;
      const corner = corners[index - 1];
      if (!corner || !Number.isFinite(corner.x) || !Number.isFinite(corner.y)) continue;
      ring.push(corner);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings.length > 0 ? rings : null;
}

/**
 * Convert one entity to local-space geometry.
 *
 * Closed polylines stay lines rather than becoming polygons: CAD linework is
 * routinely self-intersecting, and an invalid ring renders worse than an
 * outline. Only entities that are areas by definition (SOLID, 3DFACE) become
 * polygons.
 *
 * @returns The geometry, or null for an entity with nothing to draw.
 */
function entityGeometry(entity: RawEntity): LocalGeometry | null {
  switch (entity.type) {
    case "LINE": {
      // dxf-parser reports LINE as a two-entry `vertices` array, not as
      // start/end points.
      const ends = points(entity.vertices);
      return ends.length >= 2 ? { kind: "line", points: ends } : null;
    }
    case "LWPOLYLINE":
    case "POLYLINE": {
      const meshRings = polyfaceMeshRings(entity);
      if (meshRings) return { kind: "multipolygon", points: [], rings: meshRings };
      const expanded = polylinePoints(entity.vertices, entity.shape === true);
      if (expanded.length < 2) {
        return expanded.length === 1 ? { kind: "point", points: expanded } : null;
      }
      return { kind: "line", points: expanded };
    }
    case "CIRCLE": {
      const centre = point(entity.center);
      const radius = num(entity.radius, 0);
      if (!centre || radius <= 0) return null;
      return { kind: "line", points: sampleArc(centre, radius, 0, Math.PI * 2) };
    }
    case "ARC": {
      const centre = point(entity.center);
      const radius = num(entity.radius, 0);
      if (!centre || radius <= 0) return null;
      // dxf-parser normalises ARC angles to radians.
      const start = num(entity.startAngle, 0);
      const end = num(entity.endAngle, 0);
      // A DXF arc always sweeps counter-clockwise from start to end, so a
      // non-positive difference means it crosses the +X axis.
      let sweep = end - start;
      if (sweep <= 0) sweep += Math.PI * 2;
      return { kind: "line", points: sampleArc(centre, radius, start, sweep) };
    }
    case "ELLIPSE": {
      const centre = point(entity.center);
      const major = point(entity.majorAxisEndPoint);
      if (!centre || !major) return null;
      return {
        kind: "line",
        points: sampleEllipse(
          centre,
          major,
          num(entity.axisRatio, 1),
          num(entity.startAngle, 0),
          num(entity.endAngle, Math.PI * 2),
        ),
      };
    }
    case "SPLINE": {
      const control = points(entity.controlPoints);
      const fit = points(entity.fitPoints);
      if (control.length === 0) {
        return fit.length >= 2 ? { kind: "line", points: fit } : null;
      }
      const knots = Array.isArray(entity.knotValues)
        ? (entity.knotValues as unknown[]).filter((k): k is number => typeof k === "number")
        : undefined;
      const sampled = sampleSpline(num(entity.degreeOfSplineCurve, 3), knots, control);
      return sampled.length >= 2 ? { kind: "line", points: sampled } : null;
    }
    case "SOLID":
    case "3DFACE": {
      const corners = points(entity.points ?? entity.vertices);
      if (corners.length < 3) return null;
      // A DXF SOLID lists its corners in a bow-tie order (3rd and 4th swapped);
      // untangle it so the ring does not self-intersect.
      const ring = corners.length >= 4 ? [corners[0], corners[1], corners[3], corners[2]] : corners;
      return { kind: "polygon", points: ring };
    }
    case "POINT":
    case "TEXT":
    case "MTEXT":
    case "ATTRIB": {
      const anchor = point(entity.position) ?? point(entity.startPoint);
      return anchor ? { kind: "point", points: [anchor] } : null;
    }
    default:
      return null;
  }
}

/** Close a ring if the source did not, as GeoJSON polygons require. */
function closeRing(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/** Build the GeoJSON geometry for local geometry placed by `matrix`. */
function placeGeometry(local: LocalGeometry, matrix: Matrix): Geometry | null {
  if (local.kind === "multipolygon") {
    const polygons: Position[][][] = [];
    for (const ring of local.rings ?? []) {
      const placedRing = ring.map((value) => transform(matrix, value));
      if (placedRing.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) continue;
      const closed = closeRing(placedRing);
      if (closed.length >= 4) polygons.push([closed]);
    }
    // One bad face drops that face, not the whole mesh.
    return polygons.length > 0 ? { type: "MultiPolygon", coordinates: polygons } : null;
  }

  const placed = local.points.map((value) => transform(matrix, value));
  if (placed.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;

  if (local.kind === "point") return { type: "Point", coordinates: placed[0] };
  if (local.kind === "polygon") {
    const ring = closeRing(placed);
    return ring.length >= 4 ? { type: "Polygon", coordinates: [ring] } : null;
  }
  return placed.length >= 2 ? { type: "LineString", coordinates: placed } : null;
}

/**
 * Parse a DXF into a reusable drawing.
 *
 * The parser itself is imported on demand: it is only ever needed when the
 * bundled GDAL has already failed, so the bytes should not sit in the app
 * chunk that every visitor downloads.
 *
 * @param bytes The raw file.
 * @returns The parsed drawing, ready to list layers or emit features.
 * @throws When the bytes are not a DXF the parser can read.
 */
export async function parseDxfDrawing(bytes: Uint8Array): Promise<DxfDrawing> {
  // Binary DXF is a different encoding of the same model, and neither reader
  // here handles it: GDAL's DXF driver is ASCII-only, and dxf-parser reports
  // "Unexpected end of input: EOF group not read before end of file" after
  // logging a warning per record. Saying so plainly beats letting that reach
  // the user, who can fix it in one step.
  if (isBinaryDxf(bytes)) {
    throw new Error(
      "This is a binary DXF, which cannot be read. Re-save it as ASCII DXF " +
        "(in AutoCAD: Save As, then pick a plain 'AutoCAD DXF' format rather " +
        "than 'Binary DXF') and open it again.",
    );
  }

  const { default: DxfParser } = await import("dxf-parser");
  // The codepage is read from the raw bytes, then every string the parser
  // produced — it reads the file as Latin-1, byte for byte — is recoded through
  // it. That is the same repair the GDAL path applies, reused not reimplemented.
  const codepage = readDxfCodepage(bytes);
  const recode = (value: unknown): string =>
    typeof value === "string" ? recodeCadString(value, codepage) : "";

  const parsed = new DxfParser().parseSync(new TextDecoder("latin1").decode(bytes));
  if (!parsed) throw new Error("DXF parser returned no drawing");

  // `dxf-parser`'s own `IBlock`/`IEntity` types describe more than it actually
  // guarantees at runtime (its `type` is numeric on blocks, a string on
  // entities), so both are re-read through the guarded {@link RawEntity} shape.
  const blocks = (parsed.blocks ?? {}) as unknown as Record<string, RawEntity>;
  const rootEntities = (parsed.entities ?? []) as unknown as RawEntity[];

  /**
   * Walk entities, expanding INSERTs, calling `emit` for each drawable one.
   *
   * @param entities The entities to walk.
   * @param matrix The transform in force (identity at model-space top level).
   * @param depth Current block nesting depth.
   * @param chain Block names on the current path, to stop self-reference.
   * @param inherited The layer that block contents on layer "0" take on.
   * @param emit Receives the resolved layer and geometry of each drawable entity.
   */
  const walk = (
    entities: RawEntity[],
    matrix: Matrix,
    depth: number,
    chain: ReadonlySet<string>,
    inherited: string,
    emit: (layer: string, entity: RawEntity, geometry: Geometry) => void,
  ): void => {
    for (const entity of entities) {
      // AutoCAD's layer-0 rule: geometry drawn on layer "0" inside a block takes
      // the layer of the INSERT that places it, so the same symbol can appear on
      // many layers. Skipping this leaves thousands of features piled on "0",
      // where a per-layer filter cannot reach them.
      const own = recode(entity.layer) || "0";
      const layer = own === "0" ? inherited : own;

      if (entity.type === "INSERT") {
        const name = typeof entity.name === "string" ? entity.name : "";
        const block = blocks[name];
        // A block containing itself, directly or through a chain, would recurse
        // forever; a missing block is simply nothing to draw.
        if (!block || depth >= MAX_BLOCK_DEPTH || chain.has(name)) continue;
        const inner = (block.entities ?? []) as RawEntity[];
        if (inner.length === 0) continue;
        walk(
          inner,
          compose(matrix, insertMatrix(entity, point(block.position) ?? { x: 0, y: 0 })),
          depth + 1,
          new Set([...chain, name]),
          layer,
          emit,
        );
        continue;
      }

      const local = entityGeometry(entity);
      // A polyface mesh carries its geometry in `rings`, leaving `points` empty.
      if (!local || (local.points.length === 0 && !local.rings?.length)) continue;
      const geometry = placeGeometry(local, matrix);
      if (geometry) emit(layer, entity, geometry);
    }
  };

  // Tally in a first pass so the picker shows counts that match what loading
  // actually produces, rather than an estimate that disagrees with it.
  const tally = new Map<string, { count: number; kinds: Set<string> }>();
  let featureCount = 0;
  walk(rootEntities, IDENTITY, 0, new Set(), "0", (layer, _entity, geometry) => {
    featureCount += 1;
    let bucket = tally.get(layer);
    if (!bucket) {
      bucket = { count: 0, kinds: new Set() };
      tally.set(layer, bucket);
    }
    bucket.count += 1;
    bucket.kinds.add(geometry.type);
  });

  const layers: DxfLayerInfo[] = [...tally.entries()]
    .map(([name, bucket]) => ({
      name,
      featureCount: bucket.count,
      geometryType: bucket.kinds.size === 1 ? [...bucket.kinds][0] : "Mixed",
    }))
    .sort((a, b) => b.featureCount - a.featureCount || a.name.localeCompare(b.name));

  const toFeatureCollection = (layer: string): FeatureCollection => {
    const features: Feature[] = [];
    walk(rootEntities, IDENTITY, 0, new Set(), "0", (entityLayer, entity, geometry) => {
      if (layer !== ALL_LAYERS && entityLayer !== layer) return;
      if (features.length >= MAX_FEATURES) {
        throw new Error(
          `This DXF expands past ${MAX_FEATURES.toLocaleString()} features; load one CAD layer at a time.`,
        );
      }
      const text = recode(entity.text);
      features.push({
        type: "Feature",
        // Property names mirror GDAL's DXF driver so styling and filters written
        // against a GDAL-read drawing keep working here.
        properties: {
          Layer: entityLayer,
          EntityHandle: typeof entity.handle === "string" ? entity.handle : null,
          ...(text ? { Text: text } : {}),
        },
        geometry,
      });
    });
    return { type: "FeatureCollection", features };
  };

  return { layers, featureCount, codepage, toFeatureCollection };
}
