import { Select } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import type { ProgressFeatureTarget } from "../../lib/progress-colors";
import {
  ROAD_ITEM_KEYS,
  cyclePileState,
  setGirderStage,
  type GirderStage,
  type ProgressSupport,
  type ProgressV2,
  type RoadItemKey,
} from "../../lib/progress-v2";

const QUICK = [0, 25, 50, 75, 100];

export function ProgressV2Update({
  state,
  target,
  onChange,
}: {
  state: ProgressV2;
  target: ProgressFeatureTarget | null;
  onChange: (state: ProgressV2) => void;
}) {
  const { t } = useTranslation();
  if (!target)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("progress.v2.pickComponent")}
      </div>
    );
  if (target.kind === "support") {
    const bridge = state.bridges.find((item) => item.id === target.bridgeId);
    const support = bridge?.supports.find((item) => item.id === target.id);
    if (!bridge || !support) return null;
    const update = (next: ProgressSupport) =>
      onChange({
        ...state,
        bridges: state.bridges.map((item) =>
          item.id === bridge.id
            ? {
                ...item,
                supports: item.supports.map((value) => (value.id === support.id ? next : value)),
              }
            : item,
        ),
      });
    return <SupportEditor support={support} bridgeName={bridge.name} onChange={update} />;
  }
  if (target.kind === "span") {
    const bridge = state.bridges.find((item) => item.id === target.bridgeId);
    const spanIndex = bridge?.spans.findIndex((item) => item.id === target.id) ?? -1;
    const span = bridge?.spans[spanIndex];
    if (!bridge || !span) return null;
    const update = (next: typeof span) =>
      onChange({
        ...state,
        bridges: state.bridges.map((item) =>
          item.id === bridge.id
            ? { ...item, spans: item.spans.map((value) => (value.id === span.id ? next : value)) }
            : item,
        ),
      });
    return <SpanEditor state={state} bridge={bridge} spanIndex={spanIndex} onChange={update} />;
  }
  if (target.kind === "km") {
    const km = state.road.km.find((item) => item.id === target.id);
    if (!km) return null;
    return (
      <PercentEditor
        title={km.id}
        keys={ROAD_ITEM_KEYS}
        values={km.pct}
        onChange={(key, value) =>
          onChange({
            ...state,
            road: {
              km: state.road.km.map((item) =>
                item.id === km.id ? { ...item, pct: { ...item.pct, [key]: value } } : item,
              ),
            },
          })
        }
      />
    );
  }
  const underpass = state.underpasses.find((item) => item.id === target.id);
  if (!underpass) return null;
  const values = { ham_tuong: underpass.pct.tuong, ham_nap: underpass.pct.nap };
  return (
    <PercentEditor
      title={underpass.id}
      keys={["ham_tuong", "ham_nap"]}
      values={values}
      onChange={(key, value) =>
        onChange({
          ...state,
          underpasses: state.underpasses.map((item) =>
            item.id === underpass.id
              ? { ...item, pct: { ...item.pct, [key === "ham_tuong" ? "tuong" : "nap"]: value } }
              : item,
          ),
        })
      }
    />
  );
}

function SupportEditor({
  support,
  bridgeName,
  onChange,
}: {
  support: ProgressSupport;
  bridgeName: string;
  onChange: (support: ProgressSupport) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-auto rounded-sm border border-border p-2 text-xs">
      <h2 className="text-base font-bold">
        {support.id}{" "}
        <span className="text-xs font-normal text-muted-foreground">· {bridgeName}</span>
      </h2>
      <div className="my-2">
        <div className="mb-1 font-semibold">
          {t("progress.v2.items.coc")} · {support.piles.filter((pile) => pile === 2).length}/
          {support.coc.t}
        </div>
        <div className="flex flex-wrap gap-1">
          {support.piles.map((pile, index) => (
            <button
              key={index}
              type="button"
              onClick={() =>
                onChange({
                  ...support,
                  piles: support.piles.map((value, pileIndex) =>
                    pileIndex === index ? cyclePileState(value) : value,
                  ),
                })
              }
              className={`h-9 w-9 border text-[10px] font-bold ${pile === 2 ? "border-green-700 bg-green-700 text-white" : pile === 1 ? "border-amber-500 bg-amber-400" : "border-border bg-muted"}`}
            >
              C{index + 1}
            </button>
          ))}
        </div>
      </div>
      {(["be", "than", "xm"] as const).map((key) => (
        <PercentRow
          key={key}
          label={t(`progress.v2.items.${key}`)}
          value={support[key]}
          onChange={(value) => onChange({ ...support, [key]: value })}
        />
      ))}
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-sm bg-muted/40 p-2">
        <Fact label={t("progress.v2.pileDiameter")} value={`D${support.coc.D} m`} />
        <Fact label={t("progress.v2.pileLength")} value={`${support.coc.L} m`} />
        <Fact
          label={t("progress.v2.supportKind")}
          value={support.kind === "mo" ? t("progress.v2.abutment") : t("progress.v2.pier")}
        />
      </div>
      <label className="mt-3 block">
        {t("progress.v2.note")}
        <textarea
          rows={3}
          value={support.note ?? ""}
          onChange={(event) => onChange({ ...support, note: event.target.value })}
          className="mt-1 w-full border border-input bg-background p-2"
        />
      </label>
    </div>
  );
}

function SpanEditor({
  state,
  bridge,
  spanIndex,
  onChange,
}: {
  state: ProgressV2;
  bridge: ProgressV2["bridges"][number];
  spanIndex: number;
  onChange: (span: ProgressV2["bridges"][number]["spans"][number]) => void;
}) {
  const { t } = useTranslation();
  const span = bridge.spans[spanIndex];
  const ends = [bridge.supports[spanIndex], bridge.supports[spanIndex + 1]];
  return (
    <div className="h-full overflow-auto rounded-sm border border-border p-2 text-xs">
      <h2 className="text-base font-bold">
        {span.id}{" "}
        <span className="text-xs font-normal text-muted-foreground">
          · {bridge.name} · {span.L} m
        </span>
      </h2>
      <PercentRow
        label={t("progress.v2.items.bmc")}
        value={span.bmc}
        onChange={(value) => onChange({ ...span, bmc: value })}
      />
      <PercentRow
        label={t("progress.v2.items.ht")}
        value={span.ht}
        onChange={(value) => onChange({ ...span, ht: value })}
      />
      <div className="my-2 rounded-sm border border-border p-2">
        <b>{t("progress.v2.erectionConditions")}</b>
        <div className="mt-1 flex gap-1">
          {ends.map((support) =>
            support ? (
              <span
                key={support.id}
                className={`rounded-sm px-2 py-1 ${support.xm >= 100 ? "bg-green-700 text-white" : "bg-amber-400 text-black"}`}
              >
                {support.id}: {support.xm}%
              </span>
            ) : null,
          )}
          <span className="rounded-sm bg-muted px-2 py-1">
            {t("progress.v2.ready")}: {span.girders.filter((girder) => girder.st === 4).length}/
            {span.girders.filter((girder) => girder.st !== 5).length}
          </span>
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className="p-1 text-start">{t("progress.v2.girder")}</th>
            <th className="p-1 text-start">{t("progress.v2.stageColumn")}</th>
            <th className="p-1 text-start">{t("progress.v2.pourDate")}</th>
            <th className="p-1 text-end">{t("progress.v2.bed")}</th>
          </tr>
        </thead>
        <tbody>
          {span.girders.map((girder, index) => (
            <tr key={index} className="border-t border-border">
              <td className="p-1 font-semibold">D{index + 1}</td>
              <td className="p-1">
                <Select
                  className="h-7 text-xs"
                  value={girder.st}
                  onChange={(event) =>
                    onChange({
                      ...span,
                      girders: span.girders.map((item, girderIndex) =>
                        girderIndex === index
                          ? setGirderStage(
                              item,
                              Number(event.target.value) as GirderStage,
                              state.meta.reportDate,
                            )
                          : item,
                      ),
                    })
                  }
                >
                  {([0, 1, 2, 3, 4, 5] as const).map((stage) => (
                    <option key={stage} value={stage}>
                      {t(`progress.v2.stage.${stage}`)}
                    </option>
                  ))}
                </Select>
              </td>
              <td className="p-1">{girder.dob || "—"}</td>
              <td className="p-1 text-end">{girder.bed ? `B${girder.bed}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PercentEditor<T extends string>({
  title,
  keys,
  values,
  onChange,
}: {
  title: string;
  keys: readonly T[];
  values: Record<T, number>;
  onChange: (key: T, value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-auto rounded-sm border border-border p-2">
      <h2 className="mb-2 text-base font-bold">{title}</h2>
      {keys.map((key) => (
        <PercentRow
          key={key}
          label={t(`progress.v2.items.${key as RoadItemKey}`)}
          value={values[key]}
          onChange={(value) => onChange(key, value)}
        />
      ))}
    </div>
  );
}

function PercentRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="my-2 rounded-sm border border-border p-2">
      <div className="flex items-center gap-2">
        <label className="min-w-28 flex-1 text-xs font-semibold">{label}</label>
        <input
          aria-label={label}
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={(event) => onChange(Math.min(100, Math.max(0, Number(event.target.value))))}
          className="h-8 w-20 border border-input bg-background px-2 text-end text-xs"
        />
        <span className="text-xs">%</span>
      </div>
      <div className="mt-1 flex gap-1">
        {QUICK.map((quick) => (
          <button
            key={quick}
            type="button"
            onClick={() => onChange(quick)}
            className={`flex-1 border py-1 text-[10px] ${value === quick ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
          >
            {quick}
          </button>
        ))}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <b>{value}</b>
    </div>
  );
}
