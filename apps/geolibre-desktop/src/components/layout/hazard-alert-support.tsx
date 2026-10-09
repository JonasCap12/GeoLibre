import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { TFunction } from "i18next";
import * as maplibregl from "maplibre-gl";
import type { MapEngine } from "@geolibre/map";
import { Button, Input, Label } from "@geolibre/ui";
import { accuracyCircle } from "../../lib/gps-tracking";
import type { AlertKind } from "../../lib/hazard-alerts";
import type { HazardEvaluation, HazardFix } from "../../lib/hazard-zones";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

const ACCURACY_SOURCE = "__hazard_accuracy__";
const SETTINGS_KEY = "geolibre.hazard-alert";

export interface HazardUiSettings {
  nearDistanceM: number;
  silenceMinutes: number;
  sound: boolean;
  voice: boolean;
}

export const DEFAULT_HAZARD_UI: HazardUiSettings = {
  nearDistanceM: 20,
  silenceMinutes: 3,
  sound: true,
  voice: false,
};

export function loadHazardSettings(): HazardUiSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "") as Partial<HazardUiSettings>;
    if (!raw || typeof raw !== "object") return DEFAULT_HAZARD_UI;
    return {
      nearDistanceM: finiteOr(raw.nearDistanceM, DEFAULT_HAZARD_UI.nearDistanceM),
      silenceMinutes: finiteOr(raw.silenceMinutes, DEFAULT_HAZARD_UI.silenceMinutes),
      sound: raw.sound !== false,
      voice: raw.voice === true,
    };
  } catch {
    return DEFAULT_HAZARD_UI;
  }
}

export function storeHazardSettings(settings: HazardUiSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function HazardLimits({ t }: { t: TFunction }) {
  return (
    <ul className="flex list-disc flex-col gap-2 ps-5 text-sm">
      <li>{t("hazard.limitsPage")}</li>
      <li>{t("hazard.limitsGps")}</li>
      <li>{t("hazard.limitsIphone")}</li>
      <li>{t("hazard.limitsNotSafety")}</li>
    </ul>
  );
}

export function HazardBanner({
  testId,
  className,
  title,
  onAck,
  ackLabel,
}: {
  testId: string;
  className: string;
  title: string;
  onAck?: () => void;
  ackLabel?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`fixed inset-x-0 top-0 z-[80] flex flex-col items-stretch gap-3 p-4 text-center ${className}`}
    >
      <p className="text-lg font-semibold">{title}</p>
      {onAck && ackLabel ? (
        <Button type="button" className="min-h-12" onClick={onAck}>
          {ackLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function hazardStatusKey(
  summary: HazardEvaluation["summary"],
):
  | "hazard.statusInside"
  | "hazard.statusNear"
  | "hazard.statusLost"
  | "hazard.statusPoor"
  | "hazard.statusSafe"
  | "hazard.statusWaiting" {
  if (summary === "inside") return "hazard.statusInside";
  if (summary === "near") return "hazard.statusNear";
  if (summary === "lost") return "hazard.statusLost";
  if (summary === "poor") return "hazard.statusPoor";
  if (summary === "safe") return "hazard.statusSafe";
  return "hazard.statusWaiting";
}

export function hazardStatusClass(summary: HazardEvaluation["summary"]): string {
  if (summary === "inside") return "bg-red-600 text-white";
  if (summary === "near") return "bg-amber-400 text-black";
  if (summary === "safe") return "bg-green-600 text-white";
  if (summary === "poor" || summary === "lost") return "bg-neutral-800 text-white";
  return "bg-muted text-foreground";
}

export function speakHazard(text: string): void {
  if (typeof speechSynthesis === "undefined" || !text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = document.documentElement.lang || "vi";
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

export function createHazardBeep() {
  let context: AudioContext | null = null;
  let oscillator: OscillatorNode | null = null;
  const audio = () => {
    const Factory = window.AudioContext ?? window.webkitAudioContext;
    if (!Factory) return null;
    context ??= new Factory();
    void context.resume();
    return context;
  };
  return {
    unlock: () => {
      audio();
    },
    start(kind: AlertKind) {
      const ctx = audio();
      if (!ctx) return;
      oscillator?.stop();
      const tone = ctx.createOscillator();
      const gain = ctx.createGain();
      tone.type = "square" as OscillatorType;
      tone.frequency.value = kind === "enter" ? 880 : 520;
      gain.gain.value = kind === "enter" ? 0.2 : 0.08;
      tone.connect(gain);
      gain.connect(ctx.destination);
      tone.start();
      oscillator = tone;
    },
    stop() {
      oscillator?.stop();
      oscillator = null;
    },
  };
}

export function useHazardMarker(
  mapControllerRef: RefObject<MapEngine | null>,
  monitoring: boolean,
  fix: HazardFix | null,
) {
  const markerRef = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    if (!monitoring) return;
    const map = mapControllerRef.current?.getMap() ?? null;
    if (!map) return;
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      if (map.getLayer(`${ACCURACY_SOURCE}-line`)) map.removeLayer(`${ACCURACY_SOURCE}-line`);
      if (map.getLayer(ACCURACY_SOURCE)) map.removeLayer(ACCURACY_SOURCE);
      if (map.getSource(ACCURACY_SOURCE)) map.removeSource(ACCURACY_SOURCE);
    };
  }, [monitoring, mapControllerRef]);

  useEffect(() => {
    if (!monitoring || !fix) return;
    const map = mapControllerRef.current?.getMap() ?? null;
    if (!map?.isStyleLoaded()) return;
    const data = accuracyCircle({
      lng: fix.lng,
      lat: fix.lat,
      accuracy: Math.max(fix.accuracy, 1),
      timestamp: fix.timestamp,
      satellites: null,
      altitude: null,
      heading: null,
      speed: null,
    });
    const source = map.getSource(ACCURACY_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (source) void source.setData(data);
    else {
      map.addSource(ACCURACY_SOURCE, { type: "geojson", data });
      map.addLayer({
        id: ACCURACY_SOURCE,
        type: "fill",
        source: ACCURACY_SOURCE,
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: `${ACCURACY_SOURCE}-line`,
        type: "line",
        source: ACCURACY_SOURCE,
        paint: { "line-color": "#f59e0b", "line-width": 2 },
      });
    }
    if (!markerRef.current) {
      const element = document.createElement("div");
      element.style.width = "18px";
      element.style.height = "18px";
      element.style.borderRadius = "9999px";
      element.style.background = "#f59e0b";
      element.style.border = "2px solid white";
      markerRef.current = new maplibregl.Marker({ element })
        .setLngLat([fix.lng, fix.lat])
        .addTo(map);
    } else {
      markerRef.current.setLngLat([fix.lng, fix.lat]);
    }
  }, [monitoring, fix, mapControllerRef]);
}

export function useSimulateClicks(
  mapControllerRef: RefObject<MapEngine | null>,
  enabled: boolean,
  setFix: (fix: HazardFix) => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const map = mapControllerRef.current?.getMap() ?? null;
    if (!map) return;
    const onClick = (event: maplibregl.MapMouseEvent) => {
      setFix({
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
        accuracy: 8,
        timestamp: Date.now(),
      });
    };
    map.on("click", onClick);
    map.getCanvas().style.cursor = "crosshair";
    return () => {
      map.off("click", onClick);
      map.getCanvas().style.cursor = "";
    };
  }, [enabled, mapControllerRef, setFix]);
}

export function HazardZoneForm({
  t,
  zones,
  settings,
  simulate,
  monitoring,
  onToggle,
  onSettings,
  onSimulate,
  onLost,
}: {
  t: TFunction;
  zones: { id: string; name: string; flagged: boolean }[];
  settings: HazardUiSettings;
  simulate: boolean;
  monitoring: boolean;
  onToggle: (id: string, on: boolean) => void;
  onSettings: (patch: Partial<HazardUiSettings>) => void;
  onSimulate: (on: boolean) => void;
  onLost: () => void;
}) {
  return (
    <>
      <div>
        <h3 className="mb-2 text-base font-medium">{t("hazard.zonesTitle")}</h3>
        <p className="mb-2 text-sm text-muted-foreground">{t("hazard.zonesHint")}</p>
        {zones.length === 0 ? <p className="text-sm">{t("hazard.zonesEmpty")}</p> : null}
        <ul className="flex flex-col gap-2">
          {zones.map((zone) => (
            <li key={zone.id}>
              <label className="flex min-h-12 items-center gap-3 text-base">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={zone.flagged}
                  onChange={(event) => onToggle(zone.id, event.target.checked)}
                />
                {zone.name}
              </label>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Label className="flex flex-col gap-1 text-sm">
          {t("hazard.nearDistance")}
          <Input
            type="number"
            min={0}
            inputMode="decimal"
            className="min-h-12"
            value={settings.nearDistanceM}
            onChange={(event) => onSettings({ nearDistanceM: Number(event.target.value) })}
          />
        </Label>
        <Label className="flex flex-col gap-1 text-sm">
          {t("hazard.silenceMinutes")}
          <Input
            type="number"
            min={1}
            inputMode="numeric"
            className="min-h-12"
            value={settings.silenceMinutes}
            onChange={(event) => onSettings({ silenceMinutes: Number(event.target.value) })}
          />
        </Label>
      </div>
      <label className="flex min-h-12 items-center gap-3 text-base">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={settings.sound}
          onChange={(event) => onSettings({ sound: event.target.checked })}
        />
        {t("hazard.sound")}
      </label>
      <label className="flex min-h-12 items-center gap-3 text-base">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={settings.voice}
          onChange={(event) => onSettings({ voice: event.target.checked })}
        />
        {t("hazard.voice")}
      </label>
      <label className="flex min-h-12 items-center gap-3 text-base">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={simulate}
          onChange={(event) => onSimulate(event.target.checked)}
        />
        <span>
          {t("hazard.simulate")}
          <span className="mt-1 block text-sm text-muted-foreground">
            {t("hazard.simulateHint")}
          </span>
        </span>
      </label>
      {simulate && monitoring ? (
        <Button type="button" variant="outline" className="min-h-12" onClick={onLost}>
          {t("hazard.simulateLost")}
        </Button>
      ) : null}
    </>
  );
}

export function HazardScreenAlerts({
  t,
  summary,
  monitoring,
  insideNames,
  nearNames,
  onAck,
}: {
  t: TFunction;
  summary: HazardEvaluation["summary"];
  monitoring: boolean;
  insideNames: string;
  nearNames: string;
  onAck: () => void;
}) {
  return (
    <>
      {monitoring && summary === "lost" ? (
        <HazardBanner
          testId="hazard-lost"
          className="bg-neutral-900 text-white"
          title={t("hazard.bannerLost")}
        />
      ) : null}
      {monitoring && summary === "poor" ? (
        <HazardBanner
          testId="hazard-poor"
          className="bg-amber-500 text-black"
          title={t("hazard.bannerPoor")}
        />
      ) : null}
      {nearNames ? (
        <HazardBanner
          testId="hazard-near"
          className="bg-amber-400 text-black"
          title={t("hazard.bannerNear", { name: nearNames })}
          onAck={onAck}
          ackLabel={t("hazard.acknowledge")}
        />
      ) : null}
      {insideNames ? (
        <div
          data-testid="hazard-overlay"
          className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-6 bg-red-600 p-6 text-center text-white"
        >
          <p className="text-2xl font-bold">{t("hazard.statusInside")}</p>
          <p className="text-3xl font-semibold">{insideNames}</p>
          <Button
            type="button"
            className="min-h-14 min-w-40 bg-white text-lg text-red-700"
            onClick={onAck}
          >
            {t("hazard.acknowledge")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
