import { Select } from "@geolibre/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PROGRESS_V2_COLORS, type ProgressFeatureTarget } from "../../lib/progress-colors";
import {
  computeYard,
  setGirderStage,
  type BridgeState,
  type GirderStage,
  type ProgressGirder,
  type ProgressV2,
} from "../../lib/progress-v2";

const STAGES: GirderStage[] = [0, 1, 2, 3, 4, 5];

export function ProgressV2Yard({
  state,
  bridge,
  onChange,
  onOpen,
}: {
  state: ProgressV2;
  bridge: BridgeState | null;
  onChange: (state: ProgressV2) => void;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<{ span: number; girder: number } | null>(null);
  useEffect(() => setSelected(null), [bridge?.id]);
  if (!bridge) return <p className="text-sm text-muted-foreground">{t("progress.v2.noBridge")}</p>;
  const yard = computeYard(bridge, state.meta.reportDate);
  const byType = [...bridge.spans.flatMap((span) => span.girders)].reduce((rows, girder) => {
    const row = rows.get(girder.t) ?? { total: 0, cast: 0, ready: 0, erected: 0 };
    row.total += 1;
    if (girder.st >= 2) row.cast += 1;
    if (girder.st === 4) row.ready += 1;
    if (girder.st === 5) row.erected += 1;
    rows.set(girder.t, row);
    return rows;
  }, new Map<string, { total: number; cast: number; ready: number; erected: number }>());
  const chosen = selected ? bridge.spans[selected.span]?.girders[selected.girder] : null;
  const patchGirder = (spanIndex: number, girderIndex: number, next: ProgressGirder) => {
    onChange({
      ...state,
      bridges: state.bridges.map((item) =>
        item.id !== bridge.id
          ? item
          : {
              ...item,
              spans: item.spans.map((span, index) =>
                index !== spanIndex
                  ? span
                  : {
                      ...span,
                      girders: span.girders.map((girder, index) =>
                        index === girderIndex ? next : girder,
                      ),
                    },
              ),
            },
      ),
    });
  };
  const changeStage = (stage: GirderStage, wholeSpan = false) => {
    if (!selected || !chosen) return;
    if (!wholeSpan)
      return patchGirder(
        selected.span,
        selected.girder,
        setGirderStage(chosen, stage, state.meta.reportDate),
      );
    onChange({
      ...state,
      bridges: state.bridges.map((item) =>
        item.id !== bridge.id
          ? item
          : {
              ...item,
              spans: item.spans.map((span, index) =>
                index !== selected.span
                  ? span
                  : {
                      ...span,
                      girders: span.girders.map((girder) =>
                        setGirderStage(girder, stage, state.meta.reportDate),
                      ),
                    },
              ),
            },
      ),
    });
  };
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
      <div className="grid grid-cols-5 gap-1">
        <Kpi label={t("progress.v2.yard.cast")} value={`${yard.cast}/${yard.total}`} />
        <Kpi
          label={t("progress.v2.yard.onBed")}
          value={`${yard.onBed}/${bridge.yard.beds}`}
          warn={yard.onBed > bridge.yard.beds}
        />
        <Kpi label={t("progress.v2.yard.ready")} value={String(yard.ready)} />
        <Kpi label={t("progress.v2.yard.erected")} value={`${yard.erected}/${yard.total}`} />
        <button
          type="button"
          disabled={!yard.nextSpan}
          onClick={() =>
            yard.nextSpan && onOpen({ kind: "span", bridgeId: bridge.id, id: yard.nextSpan.id })
          }
          className="rounded-sm border border-border p-1 text-start disabled:opacity-60"
        >
          <span className="block truncate text-[9px] uppercase text-muted-foreground">
            {t("progress.v2.yard.next")}
          </span>
          <b className="text-sm">{yard.nextSpan?.id ?? "—"}</b>
          <small className="block truncate">
            {yard.nextSpan ? `${yard.nextSpan.ready}/${yard.nextSpan.need}` : ""}
          </small>
        </button>
      </div>
      <div className="grid min-h-0 grid-cols-[1.45fr_1fr] gap-2">
        <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
          <div className="flex shrink-0 gap-1 overflow-hidden">
            {yard.beds.map((bed) => (
              <div
                key={bed.bed}
                className={`min-w-20 flex-1 rounded-sm border p-1 text-[10px] ${bed.clash ? "border-red-600" : bed.girders.length ? "border-amber-500" : "border-border"}`}
              >
                <b>B{bed.bed}</b>
                <span className="ms-1 truncate">
                  {bed.girders.map((item) => item.id).join(", ") || t("progress.v2.yard.empty")}
                </span>
              </div>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-border p-1">
            {bridge.spans.map((span, spanIndex) => (
              <div key={span.id} className="mb-1 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpen({ kind: "span", bridgeId: bridge.id, id: span.id })}
                  className="w-9 shrink-0 text-[10px] font-bold hover:underline"
                >
                  {span.id}
                </button>
                <div className="flex flex-wrap gap-0.5">
                  {span.girders.map((girder, girderIndex) => (
                    <button
                      key={girderIndex}
                      type="button"
                      title={`${span.id}-D${girderIndex + 1}: ${t(`progress.v2.stage.${girder.st}`)}`}
                      onClick={() => setSelected({ span: spanIndex, girder: girderIndex })}
                      className={`h-8 min-w-8 border px-1 text-[9px] font-bold ${selected?.span === spanIndex && selected.girder === girderIndex ? "ring-2 ring-primary" : "border-border"}`}
                      style={{ backgroundColor: PROGRESS_V2_COLORS.girder[girder.st] }}
                    >
                      D{girderIndex + 1}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="min-h-0 overflow-auto rounded-sm border border-border p-2 text-xs">
          {!chosen || !selected ? (
            <>
              <p className="mb-2 text-muted-foreground">{t("progress.v2.yard.pickGirder")}</p>
              <h3 className="mb-1 font-bold">{t("progress.v2.yard.byType")}</h3>
              <div className="grid grid-cols-[1fr_repeat(4,auto)] gap-x-2 border-b border-border pb-1 text-[10px] font-semibold">
                <span>{t("progress.v2.yard.type")}</span>
                <span>Σ</span>
                <span>{t("progress.v2.yard.cast")}</span>
                <span>{t("progress.v2.yard.ready")}</span>
                <span>{t("progress.v2.yard.erected")}</span>
              </div>
              {[...byType].map(([type, row]) => (
                <div
                  key={type}
                  className="grid grid-cols-[1fr_repeat(4,auto)] gap-x-2 border-b border-border/50 py-1 tabular-nums"
                >
                  <span className="truncate">{type}</span>
                  <span>{row.total}</span>
                  <span>{row.cast}</span>
                  <span>{row.ready}</span>
                  <span>{row.erected}</span>
                </div>
              ))}
            </>
          ) : (
            <>
              <h3 className="mb-2 font-bold">
                {bridge.spans[selected.span].id}-D{selected.girder + 1}
              </h3>
              <div className="grid grid-cols-2 gap-1">
                {STAGES.map((stage) => (
                  <button
                    key={stage}
                    type="button"
                    aria-pressed={chosen.st === stage}
                    onClick={() => changeStage(stage)}
                    className={`min-h-8 border px-1 text-start ${chosen.st === stage ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
                  >
                    {stage}. {t(`progress.v2.stage.${stage}`)}
                  </button>
                ))}
              </div>
              <label className="mt-2 block">
                {t("progress.v2.pourDate")}
                <input
                  type="date"
                  value={chosen.dob}
                  onChange={(event) =>
                    patchGirder(selected.span, selected.girder, {
                      ...chosen,
                      dob: event.target.value,
                    })
                  }
                  className="mt-1 h-8 w-full border border-input bg-background px-2"
                />
              </label>
              <label className="mt-2 block">
                {t("progress.v2.bed")}
                <Select
                  className="mt-1 h-8 w-full"
                  value={chosen.bed}
                  onChange={(event) =>
                    patchGirder(selected.span, selected.girder, {
                      ...chosen,
                      bed: Number(event.target.value),
                    })
                  }
                >
                  <option value={0}>{t("progress.v2.unassigned")}</option>
                  {Array.from({ length: bridge.yard.beds }, (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      B{index + 1}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="mt-2 grid grid-cols-2 gap-1">
                <button
                  type="button"
                  disabled={chosen.st >= 5}
                  onClick={() => changeStage(Math.min(5, chosen.st + 1) as GirderStage)}
                  className="border border-border p-1 disabled:opacity-50"
                >
                  {t("progress.v2.nextStage")}
                </button>
                <button
                  type="button"
                  onClick={() => changeStage(chosen.st, true)}
                  className="border border-border p-1"
                >
                  {t("progress.v2.applySpan")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-sm border p-1 ${warn ? "border-red-600" : "border-border"}`}>
      <span className="block truncate text-[9px] uppercase text-muted-foreground">{label}</span>
      <b className="text-lg tabular-nums">{value}</b>
    </div>
  );
}
