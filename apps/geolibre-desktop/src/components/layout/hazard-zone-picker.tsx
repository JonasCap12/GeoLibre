import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { TFunction } from "i18next";
import type { MapEngine } from "@geolibre/map";
import { useAppStore } from "@geolibre/core";
import { Button, Input, Label } from "@geolibre/ui";
import type * as maplibregl from "maplibre-gl";
import { releaseBodyPointerEvents } from "../../lib/radix-compat";
import {
  addPickedHazardZone,
  hazardGeometryBounds,
  hazardZoneEntries,
  legacyHazardLayers,
  migrateLegacyHazardLayer,
  pickExistingHazardZoneAt,
  pickPolygonAt,
  removeHazardZone,
  unflagLegacyHazardLayer,
  updateHazardZone,
} from "../../lib/hazard-zone-picker";

interface HazardZonePickerProps {
  t: TFunction;
  mapControllerRef: RefObject<MapEngine | null>;
  /** Last pick result, shared with the banner shown while picking. */
  notice: string;
  onNotice: (notice: string) => void;
  /** Close the dialog and start picking on the map. */
  onStartPicking: () => void;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function applyProjectLayers(layers: ReturnType<typeof useAppStore.getState>["layers"]): void {
  useAppStore.setState({ layers, isDirty: true });
}

/**
 * Map clicks while picking zones.
 *
 * The modal dialog's overlay covers the map and Radix unmounts its content
 * when it closes, so picking runs with the dialog closed and this hook lives
 * at the dialog's top level (which stays mounted), the same way Field
 * Collection's "Pick on map" works. Escape calls `onExit`.
 */
export function useHazardZonePickMode({
  t,
  mapControllerRef,
  active,
  onExit,
}: {
  t: TFunction;
  mapControllerRef: RefObject<MapEngine | null>;
  active: boolean;
  onExit: () => void;
}): { notice: string; setNotice: (notice: string) => void } {
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!active) return;
    const map = mapControllerRef.current?.getMap() ?? null;
    if (!map) return;
    // Radix can leave `pointer-events: none` on <body> after the modal closes.
    releaseBodyPointerEvents();
    const raf = requestAnimationFrame(releaseBodyPointerEvents);
    const onClick = (event: maplibregl.MapMouseEvent) => {
      const point = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      const existing = pickExistingHazardZoneAt(point, useAppStore.getState().layers);
      if (existing) {
        const key =
          existing.feature.id === undefined || existing.feature.id === null
            ? `index:${existing.featureIndex}`
            : String(existing.feature.id);
        const name =
          typeof existing.feature.properties?.ten === "string"
            ? existing.feature.properties.ten
            : existing.layerName;
        if (!window.confirm(t("hazard.removePickedConfirm", { name }))) return;
        const removed = removeHazardZone(useAppStore.getState().layers, key);
        if (removed) {
          applyProjectLayers(removed.layers);
          setNotice(t("hazard.pickRemoved", { name }));
        }
        return;
      }

      const picked = pickPolygonAt(point, useAppStore.getState().layers);
      if (!picked) {
        setNotice(t("hazard.pickNone"));
        return;
      }
      const added = addPickedHazardZone(useAppStore.getState().layers, picked, {
        hazardLayerId: id("hazard-layer"),
        zoneFeatureId: id("hazard-zone"),
      });
      applyProjectLayers(added.layers);
      setNotice(t("hazard.pickAdded", { layer: picked.layerName }));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    map.on("click", onClick);
    map.getCanvas().style.cursor = "crosshair";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      map.off("click", onClick);
      map.getCanvas().style.cursor = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, mapControllerRef, onExit, t]);

  return { notice, setNotice };
}

/** Floating bar while picking: what to do, the last result, and "Done". */
export function HazardPickBanner({
  t,
  notice,
  onDone,
}: {
  t: TFunction;
  notice: string;
  onDone: () => void;
}) {
  return (
    <div
      data-testid="hazard-pick-banner"
      className="fixed inset-x-0 bottom-6 z-[60] mx-auto flex w-fit max-w-[95%] flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-xl"
    >
      <p role="status" className="text-sm font-medium">
        {t("hazard.pickActive")}
      </p>
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      <div className="flex justify-end">
        <Button type="button" className="min-h-12 min-w-28" onClick={onDone} autoFocus>
          {t("common.done")}
        </Button>
      </div>
    </div>
  );
}

/** Individual-zone authoring UI, kept separate from the monitoring dialog. */
export function HazardZonePicker({
  t,
  mapControllerRef,
  notice,
  onNotice: setNotice,
  onStartPicking,
}: HazardZonePickerProps) {
  const layers = useAppStore((state) => state.layers);
  const zones = useMemo(() => hazardZoneEntries(layers), [layers]);
  const legacy = useMemo(() => legacyHazardLayers(layers), [layers]);

  const remove = (featureKey: string, name: string) => {
    if (!window.confirm(t("hazard.removeZoneConfirm", { name }))) return;
    const result = removeHazardZone(useAppStore.getState().layers, featureKey);
    if (result) applyProjectLayers(result.layers);
  };

  const update = (
    featureKey: string,
    patch: { name?: string; level?: "nguy_hiem" | "canh_bao" },
  ) => {
    const result = updateHazardZone(useAppStore.getState().layers, featureKey, patch);
    if (result) applyProjectLayers(result.layers);
  };

  const migrate = (legacyLayerId: string, layerName: string) => {
    const result = migrateLegacyHazardLayer(useAppStore.getState().layers, legacyLayerId, {
      hazardLayerId: id("hazard-layer"),
      nextZoneFeatureId: () => id("hazard-zone"),
    });
    if (!result) return;
    applyProjectLayers(result.layers);
    setNotice(t("hazard.legacyMigrated", { layer: layerName }));
  };

  const unflag = (legacyLayerId: string, layerName: string) => {
    const result = unflagLegacyHazardLayer(useAppStore.getState().layers, legacyLayerId);
    if (!result) return;
    applyProjectLayers(result);
    setNotice(t("hazard.legacyUnflagged", { layer: layerName }));
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-base font-medium">{t("hazard.zonesTitle")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("hazard.zonesHint")}</p>
      </div>
      <Button type="button" variant="outline" className="min-h-12" onClick={onStartPicking}>
        {t("hazard.pickOnMap")}
      </Button>
      {notice ? (
        <p className="text-sm" role="status">
          {notice}
        </p>
      ) : null}

      <p className="text-sm font-medium">{t("hazard.zonesCount", { count: zones.length })}</p>
      {zones.length === 0 ? <p className="text-sm">{t("hazard.zonesEmpty")}</p> : null}
      <ul className="flex flex-col gap-3">
        {zones.map((zone) => (
          <li key={zone.featureKey} className="flex flex-col gap-2 rounded-md border p-3">
            <Label className="flex flex-col gap-1 text-sm">
              {t("hazard.zoneName")}
              <Input
                className="min-h-12"
                value={zone.name}
                onChange={(event) => update(zone.featureKey, { name: event.target.value })}
              />
            </Label>
            <Label className="flex flex-col gap-1 text-sm">
              {t("hazard.zoneLevel")}
              <select
                className="min-h-12 rounded-md border bg-background px-3"
                value={zone.level}
                onChange={(event) =>
                  update(zone.featureKey, {
                    level: event.target.value === "canh_bao" ? "canh_bao" : "nguy_hiem",
                  })
                }
              >
                <option value="nguy_hiem">{t("hazard.levelDanger")}</option>
                <option value="canh_bao">{t("hazard.levelCaution")}</option>
              </select>
            </Label>
            {zone.sourceLayerName ? (
              <p className="text-xs text-muted-foreground">
                {t("hazard.zoneSource", { layer: zone.sourceLayerName })}
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                onClick={() => {
                  const bounds = hazardGeometryBounds(zone.geometry);
                  if (bounds) mapControllerRef.current?.fitBounds(bounds);
                }}
              >
                {t("hazard.viewZone")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="min-h-12"
                onClick={() => remove(zone.featureKey, zone.name)}
              >
                {t("hazard.removeZone")}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {legacy.map((layer) => (
        <div key={layer.id} className="flex flex-col gap-2 rounded-md border border-amber-500 p-3">
          <p className="text-sm">{t("hazard.legacyNotice", { layer: layer.name })}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-12"
            onClick={() => migrate(layer.id, layer.name)}
          >
            {t("hazard.migrateLegacy")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="min-h-12"
            onClick={() => unflag(layer.id, layer.name)}
          >
            {t("hazard.unflagLegacy")}
          </Button>
        </div>
      ))}
    </section>
  );
}
