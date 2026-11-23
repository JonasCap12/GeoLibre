import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, LineString, Point, Position } from "geojson";
import {
  chainages,
  frontOf,
  linesForFront,
  workRate,
  type BoardFront,
  type BoardPhoto,
  type BoardReport,
  type BoardWorkItem,
} from "./daily-report-data";
import { foldText, lineKm, readLayerConfig, type NetworkSegment } from "./network-dashboard";

export interface ReportSelection {
  pkg: string;
  frontId: string | null;
  /** A structure selection also marks every work row at these stations. */
  stations?: number[];
}

/** Reverse of linesForFront, restricted to packages whose reports actually exist. */
export function frontForLine(
  name: string,
  reports: readonly BoardReport[],
): ReportSelection | null {
  const matches = reports.flatMap((report) =>
    report.fronts.flatMap((front) =>
      linesForFront([{ name }], report.pkg, front).length
        ? [{ pkg: report.pkg, frontId: front.id }]
        : [],
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

function contains(front: BoardFront, stations: readonly number[]): boolean {
  return (
    front.km0 !== null &&
    front.km1 !== null &&
    stations.length > 0 &&
    Math.min(...stations) >= Math.min(front.km0, front.km1) - 1 &&
    Math.max(...stations) <= Math.max(front.km0, front.km1) + 1
  );
}

/** Prefer the front starting at a shared boundary, then the route's last endpoint. */
export function frontAtStations(
  fronts: readonly BoardFront[],
  stations: readonly number[],
): BoardFront | null {
  const matches = fronts.filter((front) => contains(front, stations));
  return (
    matches.find((front) => Math.min(...stations) < Math.max(front.km0!, front.km1!)) ??
    matches[0] ??
    null
  );
}

/** Vietnamese/English package fields; neither layer ids nor a particular project's schema. */
function pointPackage(
  properties: Record<string, unknown>,
  packages: readonly string[],
): string | null {
  for (const [key, value] of Object.entries(properties)) {
    if (
      !/^(goi_?thau|goi|package|package_?code|contract_?package)$/.test(
        foldText(key).replace(/\s+/g, "_"),
      )
    )
      continue;
    if (!String(value ?? "").trim()) continue;
    const words = foldText(String(value ?? "")).split(/[^a-z0-9]+/);
    return packages.find((pkg) => words.includes(foldText(pkg))) ?? "";
  }
  return null;
}

export function structureSelection(
  name: string,
  properties: Record<string, unknown>,
  reports: readonly BoardReport[],
): ReportSelection | null {
  const stations = chainages(name);
  if (!stations.length) return null;
  const pkg = pointPackage(
    properties,
    reports.map((report) => report.pkg),
  );
  const matches = reports
    .filter((report) => pkg === null || report.pkg === pkg)
    .flatMap((report) => {
      const front = frontAtStations(report.fronts, stations);
      return front || pkg === report.pkg
        ? [{ pkg: report.pkg, frontId: front?.id ?? null, stations }]
        : [];
    });
  return matches.length === 1 ? matches[0] : null;
}

export function workAtStations(item: BoardWorkItem, stations: readonly number[]): boolean {
  return chainages(`${item.group} ${item.name}`).some((at) =>
    stations.some((station) => Math.abs(at - station) <= 1),
  );
}

/** An item's own station is more specific than its enclosing group's range. */
export function workLocationText(item: BoardWorkItem): string {
  return chainages(item.name).length ? item.name : item.group;
}

/** A photo explicitly names its front, else its caption's station decides. */
export function photoFront(photo: BoardPhoto, fronts: readonly BoardFront[]): string | null {
  const explicit = foldText(photo.caption).match(/\bmui\s*0*(\d+)\b/);
  if (explicit) {
    const front = fronts.find(
      (item) => Number(foldText(item.name).match(/\bmui\s*(\d+)\b/)?.[1]) === Number(explicit[1]),
    );
    if (front) return front.id;
  }
  return frontAtStations(fronts, chainages(photo.caption))?.id ?? null;
}

export function orderedPhotos(
  report: BoardReport,
  frontId: string | null,
): { photo: BoardPhoto; index: number; dimmed: boolean }[] {
  return report.photos
    .map((photo, index) => ({
      photo,
      index,
      dimmed: !!frontId && photoFront(photo, report.fronts) !== frontId,
    }))
    .sort((a, b) => Number(a.dimmed) - Number(b.dimmed));
}

/** The same summary-first, road-only fallback as the owner's muiProgress generator. Percent 0–100. */
export function frontProgress(report: BoardReport, front: BoardFront): number | null {
  const summary = report.muiRows.find(
    (row) =>
      row.front === front.id && (row.rateInFile !== null || (row.done !== null && !!row.planned)),
  );
  const summaryRate = summary ? (summary.rateInFile ?? summary.done! / summary.planned!) : null;
  const rates = report.work
    .filter((item) => {
      if (item.part !== "D") return false;
      const stations = chainages(`${item.group} ${item.name}`);
      return stations.length ? contains(front, stations) : item.front === front.id;
    })
    .flatMap((item) => {
      const rate = workRate(item);
      return rate === null ? [] : [Math.min(rate, 1)];
    });
  const rate =
    summaryRate ?? (rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null);
  return rate === null ? null : Math.round(Math.min(1, Math.max(0, rate)) * 1000) / 10;
}

export function frontToday(report: BoardReport, front: BoardFront): string {
  const text = report.work
    .filter((item) => frontOf(item, report.fronts) === front.id && item.today)
    .map((item) => `${item.name}: ${item.today}`)
    .join(" · ")
    .replace(/\s+/g, " ");
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

const pathLengths = (path: readonly Position[]) => {
  const lengths = [0];
  for (let i = 1; i < path.length; i++)
    lengths.push(
      lengths[i - 1] + lineKm({ type: "LineString", coordinates: [path[i - 1], path[i]] }),
    );
  return lengths;
};

function validPath(path: readonly Position[], from: number, to: number): boolean {
  return (
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    from !== to &&
    path.length >= 2 &&
    path.every((p) => p.length >= 2 && p.every(Number.isFinite))
  );
}

/** Interpolate by geodesic length; the first/last vertex correspond to from/to, including descending stations. */
export function positionAtChainage(
  path: readonly Position[],
  from: number,
  to: number,
  station: number,
): Position | null {
  if (
    !validPath(path, from, to) ||
    !Number.isFinite(station) ||
    station < Math.min(from, to) ||
    station > Math.max(from, to)
  )
    return null;
  const lengths = pathLengths(path);
  const total = lengths.at(-1)!;
  if (total <= 0) return null;
  const distance = ((station - from) / (to - from)) * total;
  if (distance === total) return [...path.at(-1)!];
  const end = lengths.findIndex((length, i) => i > 0 && length > distance);
  if (end < 1) return [...path[0]];
  const ratio = (distance - lengths[end - 1]) / (lengths[end] - lengths[end - 1]);
  return path[end - 1].map((value, i) => value + ((path[end][i] ?? value) - value) * ratio);
}

/** A clipped path preserving its intervening vertices, with no extrapolation. */
export function stretchBetween(
  path: readonly Position[],
  from: number,
  to: number,
  start: number,
  end: number,
): Position[] | null {
  const a = positionAtChainage(path, from, to, start);
  const b = positionAtChainage(path, from, to, end);
  if (!a || !b || start === end) return null;
  const lengths = pathLengths(path);
  const total = lengths.at(-1)!;
  const stations = lengths.map((length) => from + (length / total) * (to - from));
  const inside = path.filter(
    (_, i) => stations[i] > Math.min(start, end) && stations[i] < Math.max(start, end),
  );
  if ((end - start) * (to - from) < 0) inside.reverse();
  return [a, ...inside.map((position) => [...position]), b];
}

export interface ReportLocation {
  selection: ReportSelection;
  feature: Feature<Point | LineString>;
  bounds: [number, number, number, number];
}

/** Locate only on a matching front's included line, never on the nearest unrelated route. */
export function locateReportText(
  text: string,
  report: BoardReport,
  lines: readonly NetworkSegment[],
  layers: readonly GeoLibreLayer[],
): ReportLocation | null {
  const stations = chainages(text);
  const front = frontAtStations(report.fronts, stations);
  if (!front || front.km0 === null || front.km1 === null) return null;
  for (const line of linesForFront(lines, report.pkg, front)) {
    const feature = layers.find((layer) => layer.id === line.layerId)?.geojson?.features[
      line.index
    ];
    if (feature?.geometry?.type !== "LineString") continue;
    const path = feature.geometry.coordinates;
    // A layer may split one front into several lines; respect each line's own calibrated range.
    const range = Object.entries(feature.properties ?? {}).find(([key]) =>
      /^(ly_?trinh|chainage|station_?range)$/.test(foldText(key).replace(/\s+/g, "_")),
    );
    const own = range ? chainages(String(range[1])) : [];
    const from = own.length >= 2 ? own[0] : front.km0;
    const to = own.length >= 2 ? own.at(-1)! : front.km1;
    const lo = Math.min(...stations),
      hi = Math.max(...stations);
    const point = positionAtChainage(path, from, to, lo);
    if (!point) continue;
    const stretch = lo !== hi ? stretchBetween(path, from, to, lo, hi) : null;
    if (lo !== hi && !stretch) continue;
    const positions = stretch ?? [point];
    return {
      selection: { pkg: report.pkg, frontId: front.id },
      feature: {
        type: "Feature",
        properties: {},
        geometry: stretch
          ? { type: "LineString", coordinates: stretch }
          : { type: "Point", coordinates: point },
      },
      bounds: [
        Math.min(...positions.map((p) => p[0])),
        Math.min(...positions.map((p) => p[1])),
        Math.max(...positions.map((p) => p[0])),
        Math.max(...positions.map((p) => p[1])),
      ],
    };
  }
  return null;
}

/** Only visible, included in-memory layers may contribute structure hits. */
export function reportPointLayers(layers: readonly GeoLibreLayer[]): GeoLibreLayer[] {
  return layers.filter(
    (layer) =>
      layer.type === "geojson" &&
      layer.visible &&
      readLayerConfig(layer).included &&
      layer.geojson?.features.some((feature) => feature.geometry?.type === "Point"),
  );
}
