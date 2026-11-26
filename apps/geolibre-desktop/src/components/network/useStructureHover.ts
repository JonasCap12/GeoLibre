import type { GeoLibreLayer } from "@geolibre/core";
import { useEffect, useRef, useState } from "react";
import { readLayerConfig } from "../../lib/network-dashboard";
import type { DashboardCamera } from "../../lib/progress-dashboard-map";
import { reportPointLayers } from "../../lib/report-map-interaction";

export interface StructureHover {
  name: string;
  properties: Record<string, unknown>;
  /** Pointer position in viewport pixels. */
  x: number;
  y: number;
}

/**
 * The structure point under the pointer, from the visible, included point
 * layers (the same ones a click selects from), whatever their ids.
 */
export function useStructureHover(
  camera: DashboardCamera | null,
  layers: readonly GeoLibreLayer[],
): StructureHover | null {
  const [hover, setHover] = useState<StructureHover | null>(null);
  const latest = useRef(layers);
  latest.current = layers;

  useEffect(() => {
    const map = camera?.getMap?.();
    if (!map) return;
    const move = (event: { point: { x: number; y: number } }) => {
      const sources = new Map(
        reportPointLayers(latest.current).map((layer) => [`source-${layer.id}`, layer]),
      );
      const hit = sources.size
        ? map
            .queryRenderedFeatures([event.point.x, event.point.y])
            .find((feature) => sources.has(feature.source) && feature.geometry?.type === "Point")
        : undefined;
      const layer = hit && sources.get(hit.source);
      const properties = (hit?.properties ?? {}) as Record<string, unknown>;
      const name = layer ? String(properties[readLayerConfig(layer).name] ?? "").trim() : "";
      if (!name) {
        setHover(null);
        return;
      }
      const box = map.getCanvas().getBoundingClientRect();
      setHover({ name, properties, x: box.x + event.point.x, y: box.y + event.point.y });
    };
    const leave = () => setHover(null);
    map.on("mousemove", move);
    map.on("mouseout", leave);
    return () => {
      map.off("mousemove", move);
      map.off("mouseout", leave);
      setHover(null);
    };
  }, [camera]);

  return hover;
}
