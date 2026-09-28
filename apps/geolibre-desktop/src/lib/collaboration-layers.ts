import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { embedEditedGeometry, hasEditedGeometry } from "./edited-geometry-save";

/**
 * Make local vector layers portable across a collaboration connection.
 *
 * Normal project saves may intentionally retain a desktop file reference and
 * omit its features. A collaborator cannot read that path, so collaboration
 * snapshots clear the reloadable flag and embed control-managed vector data.
 * Plain GeoJSON layers already carry their features and only need the flag
 * removed so the core save preparation does not strip them.
 */
export function prepareCollaborationLayers(
  layers: GeoLibreLayer[],
  materialized: ReadonlyMap<string, FeatureCollection>,
): GeoLibreLayer[] {
  return layers.map((layer) => {
    // An edit is no longer the file the server holds. The id has to go: a peer
    // that still sees it refetches the pristine dataset and the edit never
    // arrives, while `geometryEdited` stays set on a layer of the original data.
    if (hasEditedGeometry(layer)) {
      const embedded = embedEditedGeometry(layer);
      if (embedded.metadata.sharedDatasetId === undefined) return embedded;
      const { sharedDatasetId: _id, ...metadata } = embedded.metadata;
      return { ...embedded, metadata };
    }
    // A shared-library layer already lives on the deployment's API. Embedding
    // its GeoJSON is what blows the snapshot ceiling (a survey drawing is tens
    // of megabytes). Peers fetch it by id instead. A local file has no such
    // copy, so it still embeds below. This is only safe while the features
    // still match the server copy — the edited branch above handles the rest.
    const sharedDatasetId = layer.metadata.sharedDatasetId;
    if (typeof sharedDatasetId === "string" && sharedDatasetId.trim() !== "") {
      const {
        embeddedGeoJSON: _embedded,
        localFileReloadable: _reloadable,
        ...rest
      } = layer.metadata;
      // The features also sit on `geojson`, which is what a library add writes.
      // Leaving them here would still ship the drawing. Peers refill this field
      // after they fetch the dataset.
      return { ...layer, geojson: undefined, metadata: { ...rest, sharedDatasetId } };
    }
    let metadata = layer.metadata;
    const collection = materialized.get(layer.id);
    if (collection) metadata = { ...metadata, embeddedGeoJSON: collection };
    if (metadata.localFileReloadable === true) {
      const { localFileReloadable: _localFileReloadable, ...portableMetadata } = metadata;
      metadata = portableMetadata;
    }
    return metadata === layer.metadata ? layer : { ...layer, metadata };
  });
}
