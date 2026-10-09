/**
 * Danger-zone detection for the site-safety prototype.
 *
 * Pure: no DOM and no store. A polygon layer is flagged the same way GPS
 * capture layers are flagged (`metadata.hazardZone`), so the zones save with
 * the project. This file decides, for one GPS fix, whether the worker is
 * inside a zone, near its edge, or only possibly near because the accuracy
 * circle overlaps the zone.
 *
 * Distances are metres on a local flat projection around the fix. That is
 * accurate at the tens of metres a construction site cares about. Turf's
 * point-in-polygon helper is not declared in this app, and "near" also needs
 * the distance to the edge, so the geometry lives here next to its tests.
 */
import type { MultiPolygon, Polygon, Position } from "geojson";

/** `metadata` flag marking a polygon layer as a danger zone. */
export const HAZARD_ZONE_FLAG = "hazardZone";

/** Metres per degree used by the local projection. Tests use the same number. */
export const HAZARD_METRES_PER_DEGREE = 111_320;

/** Semi-transparent red applied only when the layer still has its original style. */
export const HAZARD_FILL_COLOR = "#dc2626";
export const HAZARD_FILL_OPACITY = 0.35;
export const HAZARD_STROKE_COLOR = "#b91c1c";
export const HAZARD_STROKE_WIDTH = 2;

export type HazardLevel = "danger" | "caution";
export type ZonePresence = "outside" | "near" | "inside" | "uncertain";
export type HazardSummary = "waiting" | "lost" | "poor" | "inside" | "near" | "safe";

export interface HazardFix {
  lng: number;
  lat: number;
  /** Horizontal accuracy radius in metres. */
  accuracy: number;
  /** When the receiver produced the fix, in milliseconds. */
  timestamp: number;
}

export interface HazardZone {
  id: string;
  name: string;
  level: HazardLevel;
  geometry: Polygon | MultiPolygon;
}

export interface HazardSettings {
  /** Distance to the edge, in metres, that counts as "near". */
  nearDistanceM: number;
  /** At or beyond this accuracy, never report "safe". */
  poorAccuracyM: number;
  /**
   * Consecutive fixes required before a de-escalation (towards "outside") is
   * published. Escalation is published on the first fix.
   */
  confirmFixes: number;
  /** No fresh fix for this long means the signal is lost. */
  staleAfterMs: number;
  /**
   * Metres of extra clearance at the boundary. A fix that has only just
   * crossed the edge does not change the published presence.
   */
  marginM: number;
}

export const DEFAULT_HAZARD_SETTINGS: HazardSettings = {
  nearDistanceM: 20,
  poorAccuracyM: 50,
  confirmFixes: 2,
  staleAfterMs: 15_000,
  marginM: 3,
};

export interface ZoneTrack {
  presence: ZonePresence;
  pending: ZonePresence | null;
  pendingCount: number;
}

export interface HazardState {
  zones: Record<string, ZoneTrack>;
  /**
   * Identity of the fix the tracks were last stepped with. The dialog
   * re-evaluates every second to notice a stale signal; re-reading the same
   * fix must not count as another confirming fix.
   */
  lastFixKey?: string;
}

export type HazardEvent =
  | { type: "enter"; zone: HazardZone }
  | { type: "near"; zone: HazardZone }
  | { type: "exit"; zone: HazardZone };

export interface HazardEvaluation {
  state: HazardState;
  events: HazardEvent[];
  summary: HazardSummary;
  /** Published presence for every zone considered this call. */
  presence: Record<string, ZonePresence>;
}

export interface HazardFeature {
  id?: string | number;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

export interface HazardLayerInput {
  id: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown> | null;
  geojson?: { features?: HazardFeature[] } | null;
}

interface LocalPoint {
  x: number;
  y: number;
}

export function emptyHazardState(): HazardState {
  return { zones: {} };
}

export function isHazardZoneLayer(layer: {
  type: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  return layer.type === "geojson" && layer.metadata?.[HAZARD_ZONE_FLAG] === true;
}

/**
 * GeoJSON layers a user can mark as danger zones: polygon data, an empty
 * layer they are about to draw into, or one already flagged.
 */
export function isHazardLayerCandidate(layer: HazardLayerInput): boolean {
  if (layer.type !== "geojson") return false;
  if (isHazardZoneLayer(layer)) return true;
  const features = layer.geojson?.features;
  if (!features || features.length === 0) return true;
  return features.some(
    (feature) => feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon",
  );
}

/** Read `ten`/`name` and a `nguy_hiem` or `canh_bao` level from one feature. */
export function hazardZoneFromFeature(
  feature: HazardFeature,
  fallbackName: string,
  id: string,
): HazardZone | null {
  const geometry = feature.geometry;
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) return null;
  return {
    id,
    name: readName(feature.properties, fallbackName),
    level: readLevel(feature.properties),
    geometry: geometry as Polygon | MultiPolygon,
  };
}

/** Polygon features of every layer flagged as a danger zone. */
export function collectHazardZones(layers: readonly HazardLayerInput[]): HazardZone[] {
  const zones: HazardZone[] = [];
  for (const layer of layers) {
    if (!isHazardZoneLayer(layer)) continue;
    const features = layer.geojson?.features ?? [];
    features.forEach((feature, index) => {
      const featureId = feature.id != null ? String(feature.id) : String(index);
      const zone = hazardZoneFromFeature(feature, layer.name, `${layer.id}:${featureId}`);
      if (zone) zones.push(zone);
    });
  }
  return zones;
}

/**
 * Compare one fix with the zones.
 *
 * A missing or stale fix never reports "safe" and does not emit enter/exit:
 * losing the signal is not the same as walking out. `watchingSince` is when
 * monitoring started, so the first seconds without a fix stay "waiting"
 * rather than immediately "lost".
 */
export function evaluateHazards(
  fix: HazardFix | null,
  zones: readonly HazardZone[],
  previous: HazardState,
  settings: HazardSettings,
  now: number,
  watchingSince = now,
): HazardEvaluation {
  const confirmFixes = Math.max(1, Math.floor(settings.confirmFixes) || 1);
  if (!fix || !Number.isFinite(fix.timestamp) || now - fix.timestamp >= settings.staleAfterMs) {
    const waiting = !fix && now - watchingSince < settings.staleAfterMs;
    return {
      state: previous,
      events: [],
      summary: waiting ? "waiting" : "lost",
      presence: presenceOf(previous, zones),
    };
  }

  const events: HazardEvent[] = [];
  const nextZones: Record<string, ZoneTrack> = {};
  const presence: Record<string, ZonePresence> = {};
  const fixKey = `${fix.timestamp}|${fix.lng}|${fix.lat}|${fix.accuracy}`;
  const sameFix = previous.lastFixKey === fixKey;

  for (const zone of zones) {
    const known = previous.zones[zone.id];
    // Same reading as last time: keep the track as it is. A zone flagged since
    // then has no track yet and is evaluated normally.
    if (sameFix && known) {
      nextZones[zone.id] = known;
      presence[zone.id] = known.presence;
      continue;
    }
    const track = known ?? {
      presence: "outside",
      pending: null,
      pendingCount: 0,
    };
    const relation = relate(fix.lng, fix.lat, zone.geometry);
    const geometric = classify(relation, fix.accuracy, settings);
    const raw = applyMargin(geometric, track.presence, relation, settings.marginM);
    const stepped = stepTrack(track, raw, confirmFixes);
    nextZones[zone.id] = stepped.track;
    presence[zone.id] = stepped.track.presence;
    if (stepped.committed) {
      const event = eventFor(track.presence, stepped.committed, zone);
      if (event) events.push(event);
    }
  }

  for (const [id, track] of Object.entries(previous.zones)) {
    if (nextZones[id] || track.presence === "outside") continue;
    const zone = zones.find((entry) => entry.id === id);
    if (zone) events.push({ type: "exit", zone });
  }

  const summary = summarize(presence, zones, fix.accuracy, settings.poorAccuracyM);
  return { state: { zones: nextZones, lastFixKey: fixKey }, events, summary, presence };
}

function presenceOf(
  state: HazardState,
  zones: readonly HazardZone[],
): Record<string, ZonePresence> {
  const presence: Record<string, ZonePresence> = {};
  for (const zone of zones) presence[zone.id] = state.zones[zone.id]?.presence ?? "outside";
  return presence;
}

function summarize(
  presence: Record<string, ZonePresence>,
  zones: readonly HazardZone[],
  accuracy: number,
  poorAccuracyM: number,
): HazardSummary {
  let near = false;
  for (const zone of zones) {
    const value = presence[zone.id] ?? "outside";
    if (value === "inside") return "inside";
    if (value === "near" || value === "uncertain") near = true;
  }
  if (near) return "near";
  if (Number.isFinite(accuracy) && accuracy > poorAccuracyM) return "poor";
  return "safe";
}

function classify(
  relation: { inside: boolean; distanceM: number },
  accuracy: number,
  settings: HazardSettings,
): ZonePresence {
  if (relation.inside) return "inside";
  if (relation.distanceM <= settings.nearDistanceM) return "near";
  if (Number.isFinite(accuracy) && accuracy > 0 && relation.distanceM <= accuracy)
    return "uncertain";
  return "outside";
}

/**
 * Hold the published side of the boundary until the fix is clearly across it.
 * Never hides a fix that is inside: one just across the edge from "outside"
 * is reported as "near", not as "outside".
 */
function applyMargin(
  raw: ZonePresence,
  published: ZonePresence,
  relation: { inside: boolean; distanceM: number },
  marginM: number,
): ZonePresence {
  if (!(marginM > 0) || relation.distanceM > marginM) return raw;
  if (published === "inside" && !relation.inside) return "inside";
  if (published === "outside" && relation.inside) return "near";
  return raw;
}

/** How serious a presence is. Escalation is published at once. */
function severity(presence: ZonePresence): number {
  if (presence === "inside") return 2;
  if (presence === "near" || presence === "uncertain") return 1;
  return 0;
}

/**
 * Escalation (closer to danger) and a switch between "near" and "uncertain"
 * are published on the first fix: a delayed or skipped warning is the
 * failure this prototype must not have. Only de-escalation waits for
 * `confirmFixes` agreeing fixes, which is what stops an edge from flapping.
 */
function stepTrack(
  track: ZoneTrack,
  raw: ZonePresence,
  confirmFixes: number,
): { track: ZoneTrack; committed: ZonePresence | null } {
  if (raw === track.presence) {
    return { track: { presence: track.presence, pending: null, pendingCount: 0 }, committed: null };
  }
  if (severity(raw) >= severity(track.presence)) {
    return { track: { presence: raw, pending: null, pendingCount: 0 }, committed: raw };
  }
  const pendingCount = track.pending === raw ? track.pendingCount + 1 : 1;
  if (pendingCount >= confirmFixes) {
    return { track: { presence: raw, pending: null, pendingCount: 0 }, committed: raw };
  }
  return {
    track: { presence: track.presence, pending: raw, pendingCount },
    committed: null,
  };
}

function eventFor(from: ZonePresence, to: ZonePresence, zone: HazardZone): HazardEvent | null {
  if (to === "inside") return { type: "enter", zone };
  if (to === "outside") return from === "outside" ? null : { type: "exit", zone };
  if (from === "near" || from === "uncertain") return null;
  return { type: "near", zone };
}

function readName(
  properties: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  for (const key of ["ten", "name"]) {
    const value = properties?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function readLevel(properties: Record<string, unknown> | null | undefined): HazardLevel {
  for (const key of ["muc", "level", "muc_do"]) {
    const value = properties?.[key];
    if (typeof value !== "string") continue;
    const token = value.trim().toLowerCase();
    if (token === "canh_bao" || token === "caution" || token === "warning") return "caution";
    if (token === "nguy_hiem" || token === "danger") return "danger";
  }
  return "danger";
}

function project(lng: number, lat: number, originLat: number): LocalPoint {
  const radians = (originLat * Math.PI) / 180;
  return {
    x: lng * HAZARD_METRES_PER_DEGREE * Math.cos(radians),
    y: lat * HAZARD_METRES_PER_DEGREE,
  };
}

function ringContains(lng: number, lat: number, ring: Position[]): boolean {
  if (ring.length < 3) return false;
  const point = project(lng, lat, lat);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const start = project(ring[j][0], ring[j][1], lat);
    const end = project(ring[i][0], ring[i][1], lat);
    if (start.y === end.y) continue;
    const crosses = start.y > point.y !== end.y > point.y;
    if (!crosses) continue;
    const x = ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x;
    if (point.x < x) inside = !inside;
  }
  return inside;
}

function polygonContains(lng: number, lat: number, rings: Position[][]): boolean {
  if (rings.length === 0 || !ringContains(lng, lat, rings[0])) return false;
  for (let hole = 1; hole < rings.length; hole += 1) {
    if (ringContains(lng, lat, rings[hole])) return false;
  }
  return true;
}

function pointSegmentDistance(point: LocalPoint, start: LocalPoint, end: LocalPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function distanceToRings(lng: number, lat: number, rings: Position[][]): number {
  const point = project(lng, lat, lat);
  let best = Number.POSITIVE_INFINITY;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const next = ring[(i + 1) % ring.length];
      const current = ring[i];
      if (current[0] === next[0] && current[1] === next[1]) continue;
      const distance = pointSegmentDistance(
        point,
        project(current[0], current[1], lat),
        project(next[0], next[1], lat),
      );
      if (distance < best) best = distance;
    }
  }
  return best;
}

function relate(
  lng: number,
  lat: number,
  geometry: Polygon | MultiPolygon,
): { inside: boolean; distanceM: number } {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let inside = false;
  let distanceM = Number.POSITIVE_INFINITY;
  for (const rings of polygons) {
    if (polygonContains(lng, lat, rings)) inside = true;
    distanceM = Math.min(distanceM, distanceToRings(lng, lat, rings));
  }
  return { inside, distanceM: Number.isFinite(distanceM) ? distanceM : Number.POSITIVE_INFINITY };
}
