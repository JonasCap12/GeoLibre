import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ROAD_ITEM_KEYS, type ProgressV2ItemKey } from "../../lib/progress-v2";
import {
  DASHBOARD_STATUS_COLORS,
  dashboardStatus,
  type DashboardKind,
} from "../../lib/progress-dashboard";
import {
  dashboardBrush,
  type DashboardStructure,
  type dashboardStrip,
  type dashboardAlertGroups,
  type dashboardSchedule,
} from "../../lib/progress-dashboard-analysis";
import { usePercentFormat } from "./ProgressScreenBlocks";
import { alertText } from "./ProgressV2Overview";

export function CompactSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <details className="dashboard-select">
      <summary>
        {label} <b>{selected.length || t("progress.v2.dashboard.all")}</b>
      </summary>
      <div role="group" aria-label={label} className="dashboard-select-options">
        {options.map((o) => (
          <label key={o.id}>
            <input
              type="checkbox"
              checked={selected.includes(o.id)}
              onChange={() => onToggle(o.id)}
            />
            {o.name}
          </label>
        ))}
      </div>
    </details>
  );
}

export function DashboardMatrix({
  structures,
  onSelect,
  selected,
  items,
  printing,
}: {
  structures: DashboardStructure[];
  onSelect: (id: string, key?: ProgressV2ItemKey) => void;
  selected: string[];
  items: ProgressV2ItemKey[];
  printing: boolean;
}) {
  const { t } = useTranslation(),
    fmt = usePercentFormat();
  const [reverse, setReverse] = useState(false),
    [collapsed, setCollapsed] = useState<DashboardKind[]>([]);
  return (
    <section
      className="dashboard-card dashboard-matrix"
      aria-label={t("progress.v2.dashboard.matrix")}
    >
      <div className="dashboard-card-heading">
        <h2>{t("progress.v2.dashboard.matrix")}</h2>
        <button
          type="button"
          onClick={() => setReverse((v) => !v)}
          aria-label={t("progress.v2.dashboard.sortDeviation")}
        >
          {t("progress.deviation")} {reverse ? "↓" : "↑"}
        </button>
      </div>
      <div className="dashboard-matrix-scroll">
        {(["bridge", "underpass", "road"] as const).map((kind) => {
          const group = structures
            .filter((s) => s.kind === kind)
            .sort((a, b) => (reverse ? -1 : 1) * (a.summary.deviation - b.summary.deviation));
          if (!group.length) return null;
          const keys = [
            ...new Set(
              group.flatMap((s) => s.summary.items.filter((i) => i.applicable).map((i) => i.key)),
            ),
          ];
          return (
            <div key={kind} className="dashboard-matrix-group">
              <button
                type="button"
                className="dashboard-group-heading"
                aria-expanded={printing || !collapsed.includes(kind)}
                onClick={() =>
                  setCollapsed((v) =>
                    v.includes(kind) ? v.filter((k) => k !== kind) : [...v, kind],
                  )
                }
              >
                {t(`progress.v2.dashboard.kinds.${kind}`)} · {fmt(group.length)}
              </button>
              {printing || !collapsed.includes(kind) ? (
                <table>
                  <thead>
                    <tr>
                      <th>{t("progress.v2.dashboard.structure")}</th>
                      {keys.map((key) => (
                        <th key={key} title={t(`progress.v2.items.${key}`)}>
                          {t(`progress.v2.items.${key}`)}
                        </th>
                      ))}
                      <th>{t("progress.v2.dashboard.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.map((s) => (
                      <tr
                        key={s.id}
                        data-matrix-structure={s.id}
                        aria-selected={selected.includes(s.id)}
                      >
                        <th>
                          <button type="button" onClick={() => onSelect(s.id)}>
                            {s.name}
                          </button>
                        </th>
                        {keys.map((key) => {
                          const cell = s.summary.items.find((i) => i.key === key && i.applicable);
                          if (!cell) return <td key={key}>—</td>;
                          const status = dashboardStatus(cell.pct, cell.plannedPct);
                          return (
                            <td key={key}>
                              <button
                                type="button"
                                aria-pressed={selected.includes(s.id) && items.includes(key)}
                                style={{
                                  background: DASHBOARD_STATUS_COLORS[status],
                                  color:
                                    status === "late" || status === "done" ? "white" : "#203b2e",
                                }}
                                title={`${s.name} · ${t(`progress.v2.items.${key}`)}: ${fmt(cell.pct)}% / ${fmt(cell.plannedPct)}%`}
                                onClick={() => onSelect(s.id, key)}
                              >
                                {fmt(cell.pct)}%
                              </button>
                            </td>
                          );
                        })}
                        <td
                          className={
                            s.summary.deviation < -0.5 ? "dashboard-behind" : "dashboard-ahead"
                          }
                        >
                          <strong>{fmt(s.summary.overallPct)}%</strong>
                          <small>
                            {s.summary.deviation >= 0 ? "+" : ""}
                            {fmt(s.summary.deviation)}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          );
        })}
        {!structures.length ? <p>{t("progress.v2.dashboard.empty")}</p> : null}
      </div>
    </section>
  );
}

export function ChainageStrip({
  segments,
  extent,
  station,
  onBrush,
}: {
  segments: ReturnType<typeof dashboardStrip>;
  extent: [number, number] | null;
  station: [number, number] | null;
  onBrush: (range: [number, number]) => void;
}) {
  const { t } = useTranslation(),
    fmt = usePercentFormat();
  const [drag, setDrag] = useState<[number, number] | null>(null);
  if (!extent) return null;
  const x = (n: number) => 125 + ((n - extent[0]) / Math.max(1, extent[1] - extent[0])) * 850;
  const lines = [...ROAD_ITEM_KEYS, "bridge", "underpass"] as const;
  const fromPointer = (clientX: number, element: SVGSVGElement) => {
    const r = element.getBoundingClientRect();
    return (
      extent[0] + ((((clientX - r.left) / r.width) * 1000 - 125) / 850) * (extent[1] - extent[0])
    );
  };
  const selection = drag ? dashboardBrush(extent, ...drag) : station;
  return (
    <section
      className="dashboard-card dashboard-chainage"
      aria-label={t("progress.v2.dashboard.chainage")}
    >
      <div className="dashboard-card-heading">
        <h2>{t("progress.v2.dashboard.chainage")}</h2>
        <span>{t("progress.v2.dashboard.brushHint")}</span>
      </div>
      <svg
        viewBox="0 0 1000 120"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("progress.v2.dashboard.chainage")}
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const p = fromPointer(e.clientX, e.currentTarget);
          setDrag([p, p]);
        }}
        onPointerMove={(e) => {
          if (drag) setDrag([drag[0], fromPointer(e.clientX, e.currentTarget)]);
        }}
        onPointerUp={(e) => {
          if (drag) {
            onBrush(dashboardBrush(extent, drag[0], fromPointer(e.clientX, e.currentTarget)));
            setDrag(null);
          }
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {lines.map((key, i) => (
          <g key={key}>
            <text x="2" y={11 + i * 11} fontSize="9" fill="currentColor">
              {key === "bridge" || key === "underpass"
                ? t(`progress.v2.dashboard.kinds.${key}`)
                : t(`progress.v2.items.${key}`)}
            </text>
            <line
              x1="125"
              x2="975"
              y1={7 + i * 11}
              y2={7 + i * 11}
              stroke="currentColor"
              opacity=".08"
            />
          </g>
        ))}
        {segments.map((s) => {
          const i = lines.indexOf(
            s.kind === "road" ? (s.key as (typeof ROAD_ITEM_KEYS)[number]) : s.kind,
          );
          return (
            <rect
              key={s.id}
              x={x(s.from)}
              y={2 + i * 11}
              width={Math.max(3, x(s.to) - x(s.from))}
              height="9"
              fill={DASHBOARD_STATUS_COLORS[s.status]}
            >
              <title>
                {s.structureId}: {fmt(s.pct)}% / {fmt(s.planned)}%
              </title>
            </rect>
          );
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text
            key={f}
            x={125 + 850 * f}
            y="115"
            textAnchor={f === 1 ? "end" : "start"}
            fontSize="9"
            fill="currentColor"
          >
            {fmt((extent[0] + (extent[1] - extent[0]) * f) / 1000)} km
          </text>
        ))}
        {selection ? (
          <rect
            x={x(selection[0])}
            y="0"
            width={Math.max(2, x(selection[1]) - x(selection[0]))}
            height="100"
            fill="#176b4a"
            fillOpacity=".15"
            stroke="#176b4a"
            pointerEvents="none"
          />
        ) : null}
      </svg>
      <div className="dashboard-station-sliders">
        {([0, 1] as const).map((end) => (
          <label key={end}>
            {t(end === 0 ? "progress.v2.dashboard.from" : "progress.v2.dashboard.to")}{" "}
            {fmt((station ?? extent)[end])}
            <input
              type="range"
              min={extent[0]}
              max={extent[1]}
              value={(station ?? extent)[end]}
              aria-label={t(end === 0 ? "progress.v2.dashboard.from" : "progress.v2.dashboard.to")}
              onChange={(e) => {
                const next: [number, number] = [...(station ?? extent)];
                next[end] = Number(e.target.value);
                onBrush(dashboardBrush(extent, ...next));
              }}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

export function HistoryCurve({
  schedule,
  today,
}: {
  schedule: ReturnType<typeof dashboardSchedule>;
  today: string;
}) {
  const { t, i18n } = useTranslation(),
    fmt = usePercentFormat();
  const { history, forecast, planEnd } = schedule;
  if (!history.length) return <p>{t("progress.v2.dashboard.insufficientHistory")}</p>;
  const dates = [
    ...history.map((p) => p.date),
    today,
    ...(forecast ? [forecast] : []),
    ...(planEnd ? [planEnd] : []),
  ].filter((d) => Number.isFinite(Date.parse(d)));
  const min = Math.min(...dates.map(Date.parse)),
    max = Math.max(...dates.map(Date.parse));
  const x = (date: string) => 45 + ((Date.parse(date) - min) / Math.max(86400000, max - min)) * 510,
    y = (pct: number) => 165 - Math.min(100, Math.max(0, pct)) * 1.45;
  const date = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(value));
  const last = history[history.length - 1];
  return (
    <svg
      viewBox="0 0 600 202"
      className="dashboard-s-curve"
      role="img"
      aria-label={t("progress.v2.dashboard.sCurve")}
    >
      {[0, 25, 50, 75, 100].map((value) => (
        <g key={value}>
          <line x1="45" x2="555" y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".12" />
          <text x="2" y={y(value) + 4} fontSize="11" fill="currentColor">
            {fmt(value)}%
          </text>
        </g>
      ))}
      {(["planned", "actual"] as const).map((key) => (
        <polyline
          key={key}
          fill="none"
          stroke={key === "actual" ? "#1f7a47" : "#7b8ea4"}
          strokeWidth="2.5"
          points={history.map((p) => `${x(p.date)},${y(p[key])}`).join(" ")}
        />
      ))}
      {forecast ? (
        <line
          x1={x(last.date)}
          y1={y(last.actual)}
          x2={x(forecast)}
          y2={y(100)}
          stroke="#1f7a47"
          strokeWidth="2"
          strokeDasharray="6 4"
        />
      ) : null}
      {planEnd ? (
        <line
          x1={x(last.date)}
          y1={y(last.planned)}
          x2={x(planEnd)}
          y2={y(100)}
          stroke="#7b8ea4"
          strokeDasharray="6 4"
        />
      ) : null}
      <line x1={x(today)} x2={x(today)} y1="14" y2="168" stroke="#b45309" strokeDasharray="3 3" />
      <text x={Math.min(510, x(today) + 4)} y="12" fontSize="10" fill="#b45309">
        {t("progress.v2.dashboard.today")}
      </text>
      {[0, 0.33, 0.66, 1].map((f) => {
        const d = new Date(min + (max - min) * f).toISOString();
        return (
          <text
            key={f}
            x={45 + 510 * f}
            y="190"
            textAnchor={f === 1 ? "end" : "start"}
            fontSize="10"
            fill="currentColor"
          >
            {date(d)}
          </text>
        );
      })}
    </svg>
  );
}

export function GroupedAlerts({
  groups,
  onSelect,
}: {
  groups: ReturnType<typeof dashboardAlertGroups>;
  onSelect: (id: string, key?: ProgressV2ItemKey) => void;
}) {
  const { t } = useTranslation(),
    fmt = usePercentFormat();
  return (
    <div className="dashboard-alert-groups">
      {groups.length ? (
        groups.map((g) => (
          <details key={g.structure.id}>
            <summary>
              <span>
                {g.structure.name}
                <button
                  type="button"
                  className="dashboard-worst"
                  onClick={(event) => {
                    event.preventDefault();
                    onSelect(g.structure.id, g.worst.itemKey);
                  }}
                >
                  {g.worst.itemKey
                    ? t(`progress.v2.items.${g.worst.itemKey}`)
                    : g.worst.alert
                      ? alertText(t, g.worst.alert, fmt)
                      : t("progress.v2.dashboard.sequence")}{" "}
                  {g.worst.itemKey ? (
                    <strong>
                      {g.worst.deviation >= 0 ? "+" : ""}
                      {fmt(g.worst.deviation)}%
                    </strong>
                  ) : null}
                </button>
              </span>
              <b>{g.entries.length}</b>
            </summary>
            <div className="dashboard-alert-entries">
              {g.entries.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onSelect(g.structure.id, e.itemKey)}
                >
                  {e.alert
                    ? alertText(t, e.alert, fmt)
                    : e.itemKey
                      ? t(`progress.v2.items.${e.itemKey}`)
                      : ""}
                  <span>
                    {e.itemKey
                      ? `${fmt(e.actual)}% / ${fmt(e.planned)}% · ${fmt(e.deviation)}%`
                      : ""}
                  </span>
                </button>
              ))}
            </div>
          </details>
        ))
      ) : (
        <p>{t("progress.v2.noAlerts")}</p>
      )}
    </div>
  );
}
