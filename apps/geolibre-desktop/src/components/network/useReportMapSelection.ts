import {
  progressDashboardFeature,
  registerMapClickClaim,
  type GeoLibreLayer,
} from "@geolibre/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { dialogOpen } from "../../lib/daily-report-board";
import { linesForFront, type BoardFront } from "../../lib/daily-report-data";
import { readLayerConfig, type NetworkSegment } from "../../lib/network-dashboard";
import { closeNetworkDashboard } from "../../lib/network-dashboard-screen";
import type { DashboardCamera } from "../../lib/progress-dashboard-map";
import {
  frontForLine,
  locateReportText,
  reportPointLayers,
  structureSelection,
  type ReportLocation,
  type ReportSelection,
} from "../../lib/report-map-interaction";
import type { useBoardReports } from "./useBoardReports";

export function useReportMapSelection(
  enabled: boolean,
  camera: DashboardCamera | null,
  layers: readonly GeoLibreLayer[],
  lines: readonly NetworkSegment[],
  board: ReturnType<typeof useBoardReports>,
  fitTo: (lines: readonly NetworkSegment[]) => void,
) {
  const [selection, setSelection] = useState<ReportSelection | null>(null);
  const [hovered, setHovered] = useState<ReportSelection | null>(null);
  const [location, setLocation] = useState<ReportLocation | null>(null);
  const clear = useCallback(() => {
    setSelection(null);
    setHovered(null);
    setLocation(null);
  }, []);
  const choose = (next: ReportSelection) => {
    setLocation(null);
    setHovered(null);
    setSelection(next);
    if (board.pkg !== next.pkg) board.choosePackage(next.pkg);
  };
  const latest = useRef({ layers, lines, board, choose, clear });
  latest.current = { layers, lines, board, choose, clear };

  useEffect(() => {
    if (!enabled) {
      clear();
      return;
    }
    const release = registerMapClickClaim(() => true);
    const map = camera?.getMap?.();
    const click = (event: { point: { x: number; y: number } }) => {
      const current = latest.current;
      const points = reportPointLayers(current.layers);
      const sources = new Map(
        current.layers
          .filter(
            (layer) =>
              current.lines.some((line) => line.layerId === layer.id) || points.includes(layer),
          )
          .map((layer) => [`source-${layer.id}`, layer]),
      );
      const hits = map?.queryRenderedFeatures([event.point.x, event.point.y]) ?? [];
      let relevant = false;
      // Structures win over the front line beneath them.
      for (const hit of hits) {
        const layer = sources.get(hit.source);
        if (!layer || !points.includes(layer) || hit.geometry?.type !== "Point") continue;
        relevant = true;
        const props = hit.properties ?? {};
        const name = String(props[readLayerConfig(layer).name] ?? "");
        const selected = structureSelection(name, props, current.board.reports);
        if (selected) {
          current.choose(selected);
          return;
        }
      }
      for (const hit of hits) {
        const layer = sources.get(hit.source);
        if (!layer || hit.geometry?.type === "Point") continue;
        relevant = true;
        const original = progressDashboardFeature(layer, hit.properties);
        const line =
          original &&
          current.lines.find((item) => item.layerId === layer.id && item.index === original.index);
        const selected = line && frontForLine(line.name, current.board.reports);
        if (selected) {
          current.choose(selected);
          return;
        }
      }
      if (!relevant) current.clear();
    };
    map?.on("click", click);
    return () => {
      release();
      map?.off("click", click);
    };
  }, [enabled, camera, clear]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The board's own dialogs (its review after "Nạp báo cáo") close on Escape themselves.
      if (event.key !== "Escape" || dialogOpen(document)) return;
      if (enabled && (selection || hovered || location)) {
        event.preventDefault();
        clear();
      } else closeNetworkDashboard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, selection, hovered, location, clear]);

  useEffect(() => {
    setLocation(null);
    setHovered(null);
    setSelection((current) => (current?.pkg === board.pkg ? current : null));
  }, [board.pkg, board.date]);

  useEffect(() => {
    if (!enabled || !location) return;
    camera?.setTransientHighlight?.({ type: "FeatureCollection", features: [location.feature] });
    const timer = window.setTimeout(() => setLocation(null), 6000);
    return () => {
      window.clearTimeout(timer);
      camera?.setTransientHighlight?.(null);
    };
  }, [enabled, location, camera]);

  return {
    selection: enabled ? selection : null,
    emphasis: enabled ? (hovered ?? selection) : null,
    clear,
    onHoverFront: (front: BoardFront | null) =>
      setHovered(front && board.pkg ? { pkg: board.pkg, frontId: front.id } : null),
    onShowFront: (pkg: string, front: BoardFront) => {
      choose({ pkg, frontId: front.id });
      fitTo(linesForFront(lines, pkg, front));
    },
    locate: (text: string) =>
      board.report ? locateReportText(text, board.report, lines, layers) : null,
    onLocate: (next: ReportLocation) => {
      choose(next.selection);
      setLocation(next);
      const map = camera?.getMap?.();
      if (map && next.feature.geometry.type === "Point")
        map.flyTo({
          center: next.feature.geometry.coordinates as [number, number],
          zoom: 16,
          duration: 500,
        });
      else if (map)
        map.fitBounds(
          [
            [next.bounds[0], next.bounds[1]],
            [next.bounds[2], next.bounds[3]],
          ],
          { padding: 60, maxZoom: 16, duration: 500 },
        );
      else camera?.fitBounds(next.bounds);
    },
  };
}
