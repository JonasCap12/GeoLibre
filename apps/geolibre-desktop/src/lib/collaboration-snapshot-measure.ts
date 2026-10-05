import { redactCredentials, serializeProject, type GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { RefObject } from "react";
import { buildProjectSnapshot } from "./build-project-snapshot";
import { prepareCollaborationLayers } from "./collaboration-layers";

/**
 * Size a layer list the way the snapshot the relay receives is sized.
 *
 * `shrinkCollaborationLayers` needs a price per candidate list, and pricing it
 * any other way would let the estimate drift from what is actually sent: a
 * promoted layer has to count as its id rather than its features, and
 * `prepareCollaborationLayers` is what decides that.
 *
 * Alone in its own module because `buildProjectSnapshot` reaches the plugin
 * manager, which pulls in Vite `virtual:` modules. A Node test cannot import
 * that chain, so the parts worth asserting live in
 * `collaboration-snapshot-shrink.ts` instead and this stays a thin adapter.
 */
export function collaborationSnapshotMeasure(
  mapControllerRef: RefObject<MapEngine | null>,
): (layers: GeoLibreLayer[]) => number {
  return (layers) => {
    const prepared = prepareCollaborationLayers(layers, new Map());
    const next = redactCredentials(buildProjectSnapshot(mapControllerRef, { layers: prepared }));
    return new TextEncoder().encode(serializeProject(next)).length;
  };
}
