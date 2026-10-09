import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { RefObject } from "react";
import type { MapEngine } from "@geolibre/map";
import { isInitialLayerStyle, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { ShieldAlert } from "lucide-react";
import { fixFromPosition, formatAccuracy } from "../../lib/gps-tracking";
import {
  HazardLimits,
  HazardScreenAlerts,
  HazardZoneForm,
  createHazardBeep,
  hazardStatusClass,
  hazardStatusKey,
  loadHazardSettings,
  speakHazard,
  storeHazardSettings,
  useHazardMarker,
  useSimulateClicks,
  type HazardUiSettings,
} from "./hazard-alert-support";
import { GeolocationError, watchPosition } from "../../lib/geolocation";
import {
  acknowledgeZone,
  DEFAULT_REPEAT_MS,
  emptyAlertMemory,
  markAlerted,
  shouldAlert,
  triggerVibration,
  type AlertKind,
  type AlertMemory,
} from "../../lib/hazard-alerts";
import {
  collectHazardZones,
  DEFAULT_HAZARD_SETTINGS,
  emptyHazardState,
  evaluateHazards,
  HAZARD_FILL_COLOR,
  HAZARD_FILL_OPACITY,
  HAZARD_STROKE_COLOR,
  HAZARD_STROKE_WIDTH,
  HAZARD_ZONE_FLAG,
  isHazardLayerCandidate,
  type HazardEvaluation,
  type HazardFix,
  type HazardState,
  type HazardZone,
} from "../../lib/hazard-zones";

interface HazardAlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * Danger-zone alert. The worker's position stays in this component: it is
 * drawn on the map and never written into the project or sent anywhere.
 */
export function HazardAlertDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: HazardAlertDialogProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const candidates = useMemo(() => layers.filter(isHazardLayerCandidate), [layers]);
  const zones = useMemo(() => collectHazardZones(layers), [layers]);

  const [settings, setSettings] = useState<HazardUiSettings>(loadHazardSettings);
  const [monitoring, setMonitoring] = useState(false);
  const [simulate, setSimulate] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [limitsSeen, setLimitsSeen] = useState(false);
  const [fix, setFix] = useState<HazardFix | null>(null);
  const [gpsError, setGpsError] = useState<"denied" | "unavailable" | null>(null);
  const [wake, setWake] = useState<"on" | "unavailable" | "released">("on");
  const [evaluation, setEvaluation] = useState<HazardEvaluation>(() =>
    evaluateHazards(null, [], emptyHazardState(), DEFAULT_HAZARD_SETTINGS, Date.now(), Date.now()),
  );
  const [alarm, setAlarm] = useState<{ kind: AlertKind; zones: HazardZone[] } | null>(null);

  const fixRef = useRef(fix);
  const zonesRef = useRef(zones);
  const stateRef = useRef<HazardState>(emptyHazardState());
  const memoryRef = useRef<AlertMemory>(emptyAlertMemory());
  const startedRef = useRef(0);
  const settingsRef = useRef(settings);
  const soundRef = useRef<ReturnType<typeof createHazardBeep> | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  fixRef.current = fix;
  zonesRef.current = zones;
  settingsRef.current = settings;

  const publish = useCallback((now: number) => {
    const result = evaluateHazards(
      fixRef.current,
      zonesRef.current,
      stateRef.current,
      { ...DEFAULT_HAZARD_SETTINGS, nearDistanceM: settingsRef.current.nearDistanceM },
      now,
      startedRef.current,
    );
    stateRef.current = result.state;
    setEvaluation(result);
    if (result.summary === "lost" || result.summary === "waiting") {
      soundRef.current?.stop();
      setAlarm(null);
      return;
    }
    let memory = memoryRef.current;
    const ringing: HazardZone[] = [];
    let kind: AlertKind = "near";
    const consider = (zone: HazardZone, nextKind: AlertKind) => {
      if (!shouldAlert(memory, zone.id, now, DEFAULT_REPEAT_MS, nextKind)) return;
      memory = markAlerted(memory, zone.id, now, nextKind);
      if (nextKind === "enter") kind = "enter";
      ringing.push(zone);
    };
    for (const event of result.events) {
      if (event.type === "exit") continue;
      consider(event.zone, event.type === "enter" ? "enter" : "near");
    }
    for (const zone of zonesRef.current) {
      const presence = result.presence[zone.id];
      if (presence === "inside") consider(zone, "enter");
      else if (presence === "near" || presence === "uncertain") consider(zone, "near");
    }
    memoryRef.current = memory;
    if (ringing.length === 0) {
      const still = zonesRef.current.some((zone) => {
        const presence = result.presence[zone.id];
        return presence === "inside" || presence === "near" || presence === "uncertain";
      });
      if (!still) {
        soundRef.current?.stop();
        setAlarm(null);
      }
      return;
    }
    const alertKind = ringing.some((zone) => result.presence[zone.id] === "inside")
      ? "enter"
      : kind;
    triggerVibration(
      { vibrate: navigator.vibrate?.bind(navigator), userAgent: navigator.userAgent },
      alertKind,
    );
    if (settingsRef.current.sound) soundRef.current?.start(alertKind);
    else soundRef.current?.stop();
    if (settingsRef.current.voice) {
      const name = ringing.map((zone) => zone.name).join(", ");
      speakHazard(
        tRef.current(alertKind === "enter" ? "hazard.voiceInside" : "hazard.voiceNear", { name }),
      );
    }
    setAlarm({ kind: alertKind, zones: ringing });
  }, []);

  useEffect(() => {
    if (!monitoring) return;
    publish(Date.now());
    const id = window.setInterval(() => publish(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [monitoring, publish, fix, zones, settings.nearDistanceM]);

  useEffect(() => {
    if (!monitoring || simulate) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    setGpsError(null);
    watchPosition(
      (position) => {
        const next = fixFromPosition(position);
        setFix({
          lng: next.lng,
          lat: next.lat,
          accuracy: next.accuracy,
          timestamp: next.timestamp,
        });
      },
      (error) => setGpsError(error.permissionDenied ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 0 },
    )
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else stop = unsubscribe;
      })
      .catch((error: unknown) => {
        const denied = error instanceof GeolocationError && error.permissionDenied;
        setGpsError(denied ? "denied" : "unavailable");
        setMonitoring(false);
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [monitoring, simulate]);

  useEffect(() => {
    if (!monitoring) return;
    let released = false;
    let sentinel: WakeLockSentinel | null = null;
    const request = () => {
      if (!("wakeLock" in navigator)) {
        setWake("unavailable");
        return;
      }
      navigator.wakeLock
        .request("screen")
        .then((next) => {
          if (released) {
            void next.release();
            return;
          }
          sentinel = next;
          setWake("on");
          next.addEventListener("release", () => {
            if (!released) setWake("released");
          });
        })
        .catch(() => setWake("unavailable"));
    };
    request();
    const onVisible = () => {
      if (document.visibilityState === "visible") request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, [monitoring]);

  useHazardMarker(mapControllerRef, monitoring, fix);
  useSimulateClicks(mapControllerRef, monitoring && simulate, setFix);

  const start = () => {
    soundRef.current ??= createHazardBeep();
    soundRef.current.unlock();
    if (!limitsSeen) {
      setShowLimits(true);
      return;
    }
    begin();
  };

  const begin = () => {
    soundRef.current?.unlock();
    stateRef.current = emptyHazardState();
    memoryRef.current = emptyAlertMemory();
    startedRef.current = Date.now();
    setFix(null);
    setAlarm(null);
    setLimitsSeen(true);
    setShowLimits(false);
    setMonitoring(true);
  };

  const stop = () => {
    setMonitoring(false);
    setAlarm(null);
    soundRef.current?.stop();
    setFix(null);
  };

  const acknowledge = () => {
    const now = Date.now();
    const silenceMs = settings.silenceMinutes * 60_000;
    let memory = memoryRef.current;
    for (const zone of alarm?.zones ?? [])
      memory = acknowledgeZone(memory, zone.id, now, silenceMs);
    memoryRef.current = memory;
    soundRef.current?.stop();
    setAlarm(null);
  };

  const toggleZone = (layer: GeoLibreLayer, on: boolean) => {
    const metadata = { ...(layer.metadata ?? {}) };
    if (on) metadata[HAZARD_ZONE_FLAG] = true;
    else delete metadata[HAZARD_ZONE_FLAG];
    const patch: Partial<GeoLibreLayer> = { metadata };
    if (on && isInitialLayerStyle(layer.style, layer.geojson)) {
      patch.style = {
        ...layer.style,
        fillColor: HAZARD_FILL_COLOR,
        fillOpacity: HAZARD_FILL_OPACITY,
        strokeColor: HAZARD_STROKE_COLOR,
        strokeWidth: HAZARD_STROKE_WIDTH,
      };
    }
    updateLayer(layer.id, patch);
  };

  const updateSettings = (patch: Partial<HazardUiSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    storeHazardSettings(next);
  };

  const summary = monitoring ? evaluation.summary : "waiting";
  const alarming = alarm?.zones ?? [];
  const inside = alarming.filter((zone) => evaluation.presence[zone.id] === "inside");
  const near = alarming.filter(
    (zone) =>
      inside.length === 0 &&
      (evaluation.presence[zone.id] === "near" || evaluation.presence[zone.id] === "uncertain"),
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <ShieldAlert className="h-5 w-5" />
              {t("hazard.title")}
            </DialogTitle>
            <DialogDescription>{t("hazard.description")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 overflow-y-auto px-6 pb-6 text-start">
            <p className="text-sm text-muted-foreground">{t("hazard.privacy")}</p>
            <div
              data-testid="hazard-status"
              className={`rounded-md px-3 py-3 text-center text-lg font-semibold ${hazardStatusClass(summary)}`}
            >
              {t(hazardStatusKey(summary))}
            </div>
            <p className="text-base">
              {t("hazard.accuracy")}{" "}
              {fix ? formatAccuracy(fix.accuracy, t("hazard.noFix")) : t("hazard.noFix")}
              {" · "}
              {t("hazard.lastFix")}{" "}
              {fix
                ? new Intl.DateTimeFormat(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  }).format(fix.timestamp)
                : t("hazard.noFix")}
            </p>
            {gpsError ? (
              <p className="text-sm text-destructive">
                {t(gpsError === "denied" ? "hazard.permissionDenied" : "hazard.unavailable")}
              </p>
            ) : null}
            {monitoring && wake !== "on" ? (
              <p className="text-sm">{t("hazard.wakeLockOff")}</p>
            ) : null}
            {showLimits ? <HazardLimits t={t} /> : null}
            {!monitoring && !showLimits ? (
              <Button type="button" className="min-h-14 text-lg" onClick={start}>
                {t("hazard.start")}
              </Button>
            ) : null}
            {showLimits && !monitoring ? (
              <Button type="button" className="min-h-14 text-lg" onClick={begin}>
                {t("hazard.acceptAndStart")}
              </Button>
            ) : null}
            {monitoring ? (
              <Button type="button" variant="outline" className="min-h-14 text-lg" onClick={stop}>
                {t("hazard.stop")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="min-h-12"
              onClick={() => setShowLimits((value) => !value)}
            >
              {t("hazard.showLimits")}
            </Button>
            <HazardZoneForm
              t={t}
              zones={candidates.map((layer) => ({
                id: layer.id,
                name: layer.name,
                flagged: layer.metadata?.[HAZARD_ZONE_FLAG] === true,
              }))}
              settings={settings}
              simulate={simulate}
              monitoring={monitoring}
              onToggle={(id, on) => {
                const layer = candidates.find((entry) => entry.id === id);
                if (layer) toggleZone(layer, on);
              }}
              onSettings={updateSettings}
              onSimulate={setSimulate}
              onLost={() =>
                setFix((current) =>
                  current
                    ? { ...current, timestamp: Date.now() - 60_000 }
                    : { lng: 0, lat: 0, accuracy: 8, timestamp: Date.now() - 60_000 },
                )
              }
            />
          </div>
        </DialogContent>
      </Dialog>
      {createPortal(
        <HazardScreenAlerts
          t={t}
          summary={evaluation.summary}
          monitoring={monitoring}
          insideNames={inside.map((zone) => zone.name).join(", ")}
          nearNames={near.map((zone) => zone.name).join(", ")}
          onAck={acknowledge}
        />,
        document.body,
      )}
    </>
  );
}
