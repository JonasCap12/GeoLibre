import { useTranslation } from "react-i18next";
import {
  progressStateColor,
  PROGRESS_V2_COLORS,
  type ProgressFeatureTarget,
} from "../../lib/progress-colors";
import {
  computeProgressV2,
  supportItemPct,
  type BridgeState,
  type ProgressV2,
} from "../../lib/progress-v2";

export function ProgressV2Profile({
  state,
  packageId,
  bridges,
  bridge,
  onBridge,
  onOpen,
}: {
  state: ProgressV2;
  packageId: string | null;
  bridges: BridgeState[];
  bridge: BridgeState | null;
  onBridge: (id: string) => void;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="progress-screen-profile border-b border-border bg-card px-2 py-1 text-foreground">
      <div className="flex h-7 items-center gap-1 overflow-hidden">
        <strong className="me-1 shrink-0 text-[11px] uppercase text-primary">
          {t("progress.v2.profile")}
        </strong>
        {bridges.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onBridge(item.id)}
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
              bridge?.id === item.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-muted"
            }`}
          >
            {item.name}
          </button>
        ))}
      </div>
      {bridge ? (
        <BridgeProfile bridge={bridge} onOpen={onOpen} />
      ) : (
        <RoadProfile state={state} packageId={packageId} onOpen={onOpen} />
      )}
    </section>
  );
}

function BridgeProfile({
  bridge,
  onOpen,
}: {
  bridge: BridgeState;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const { t } = useTranslation();
  const width = Math.max(720, bridge.spans.length * 120 + 100);
  const gap = (width - 100) / Math.max(1, bridge.supports.length - 1);
  return (
    <div className="h-[92px] overflow-x-auto overflow-y-hidden">
      <svg viewBox={`0 0 ${width} 92`} className="h-full min-w-full" role="img">
        {bridge.spans.map((span, index) => {
          const x = 50 + index * gap;
          return (
            <g
              key={span.id}
              role="button"
              tabIndex={0}
              className="cursor-pointer"
              onClick={() => onOpen({ kind: "span", bridgeId: bridge.id, id: span.id })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ")
                  onOpen({ kind: "span", bridgeId: bridge.id, id: span.id });
              }}
            >
              <line
                x1={x + 8}
                x2={x + gap - 8}
                y1={46}
                y2={46}
                stroke={progressStateColor(span.bmc).color}
                strokeWidth={8}
              />
              {span.girders.slice(0, 10).map((girder, girderIndex) => (
                <line
                  key={girderIndex}
                  x1={x + 10 + (girderIndex * (gap - 20)) / Math.max(1, span.girders.length)}
                  x2={x + 10 + (girderIndex * (gap - 20)) / Math.max(1, span.girders.length)}
                  y1={52}
                  y2={64}
                  stroke={PROGRESS_V2_COLORS.girder[girder.st]}
                  strokeWidth={4}
                />
              ))}
              <text
                x={x + gap / 2}
                y={78}
                textAnchor="middle"
                className="fill-foreground text-[10px]"
              >
                {span.id}
              </text>
              {span.lien ? (
                <text
                  x={x + gap / 2}
                  y={11}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[9px]"
                >
                  {span.lien}
                </text>
              ) : null}
            </g>
          );
        })}
        {bridge.supports.map((support, index) => {
          const x = 50 + index * gap;
          const parts = [supportItemPct(support, "coc"), support.be, support.than, support.xm];
          return (
            <g
              key={support.id}
              role="button"
              tabIndex={0}
              className="cursor-pointer"
              onClick={() => onOpen({ kind: "support", bridgeId: bridge.id, id: support.id })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ")
                  onOpen({ kind: "support", bridgeId: bridge.id, id: support.id });
              }}
            >
              {parts.map((pct, part) => (
                <rect
                  key={part}
                  x={x - 7}
                  y={48 - part * 9}
                  width={14}
                  height={7}
                  fill={progressStateColor(pct).color}
                />
              ))}
              <text x={x} y={89} textAnchor="middle" className="fill-foreground text-[9px]">
                {support.id}
              </text>
            </g>
          );
        })}
        <text x={8} y={62} className="fill-muted-foreground text-[9px]">
          {t("progress.v2.approachShort")}
        </text>
        <text x={width - 22} y={62} className="fill-muted-foreground text-[9px]">
          {t("progress.v2.approachShort")}
        </text>
      </svg>
    </div>
  );
}

function RoadProfile({
  state,
  packageId,
  onOpen,
}: {
  state: ProgressV2;
  packageId: string | null;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const packageItem = state.packages.find((item) => item.id === packageId);
  const km = state.road.km.filter(
    (item) =>
      !packageItem ||
      Math.max(item.from, packageItem.fromStation) < Math.min(item.to, packageItem.toStation),
  );
  return (
    <div className="flex h-[92px] items-center gap-1 overflow-x-auto py-2">
      {km.map((item) => {
        const pct = computeProgressV2(
          { ...state, bridges: [], underpasses: [], road: { km: [item] } },
          packageId,
        ).overallPct;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen({ kind: "km", id: item.id })}
            className="flex h-14 min-w-20 flex-col items-center justify-center border border-border text-xs"
            style={{ backgroundColor: progressStateColor(pct).color }}
          >
            <b>{item.id}</b>
            <span>{Math.round(pct)}%</span>
          </button>
        );
      })}
    </div>
  );
}
