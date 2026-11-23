import type { MapEngine } from "@geolibre/map";
import type { FeatureCollection } from "geojson";
import { useCallback, useState, type RefObject } from "react";

export type MapReady<T> = (app: T, highlight: (features: FeatureCollection | null) => void) => void;

/** Repeated style loads advance readiness; the highlight bridge always uses the current engine. */
export function useMapReady<T>(
  controller: RefObject<MapEngine | null>,
  createApi: (controller: RefObject<MapEngine | null>) => T,
  onReady: MapReady<T> | undefined,
) {
  const [generation, setGeneration] = useState(0);
  const ready = useCallback(() => {
    setGeneration((value) => value + 1);
    onReady?.(createApi(controller), (features) =>
      controller.current?.setTransientHighlight?.(features),
    );
  }, [controller, createApi, onReady]);
  return [generation, ready] as const;
}
