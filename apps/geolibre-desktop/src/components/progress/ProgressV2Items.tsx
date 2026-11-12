import { Select } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProgressFeatureTarget } from "../../lib/progress-colors";
import {
  BRIDGE_ITEM_KEYS,
  PROGRESS_V2_ITEM_KEYS,
  ROAD_ITEM_KEYS,
  UNDERPASS_ITEM_KEYS,
  bridgeItemQuantityText,
  bridgesInPackage,
  computeProgressV2,
  packageForStation,
  spanItemPct,
  supportItemPct,
  type BridgeItemKey,
  type ProgressV2,
  type ProgressV2ItemKey,
  type RoadItemKey,
} from "../../lib/progress-v2";
import { fmt } from "./ProgressScreenBlocks";

export function ProgressV2Items({
  state,
  packageId,
  onChange,
  onOpen,
}: {
  state: ProgressV2;
  packageId: string | null;
  onChange: (state: ProgressV2) => void;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const { t, i18n } = useTranslation();
  const [key, setKey] = useState<ProgressV2ItemKey>("coc");
  const summary = computeProgressV2(state, packageId);
  const result = summary.items.find((item) => item.key === key)!;
  const bridges = bridgesInPackage(state, packageId);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 rounded-sm border border-border p-2">
        <label className="text-xs font-semibold" htmlFor="progress-v2-item">
          {t("progress.items")}
        </label>
        <Select
          id="progress-v2-item"
          className="h-8 min-w-40 flex-1 text-xs"
          value={key}
          onChange={(event) => setKey(event.target.value as ProgressV2ItemKey)}
        >
          {PROGRESS_V2_ITEM_KEYS.map((item) => (
            <option key={item} value={item}>
              {t(`progress.v2.items.${item}`)}
            </option>
          ))}
        </Select>
        <strong className="tabular-nums">{fmt(result.pct)}%</strong>
        <span className="hidden text-xs text-muted-foreground xl:inline">
          {BRIDGE_ITEM_KEYS.includes(key as BridgeItemKey)
            ? bridgeItemQuantityText(bridges, key as BridgeItemKey, t, i18n.language)
            : null}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-border">
        {BRIDGE_ITEM_KEYS.includes(key as BridgeItemKey) ? (
          <BridgeRows bridges={bridges} itemKey={key as BridgeItemKey} onOpen={onOpen} />
        ) : ROAD_ITEM_KEYS.includes(key as RoadItemKey) ? (
          <RoadRows
            state={state}
            packageId={packageId}
            itemKey={key as RoadItemKey}
            onChange={onChange}
            onOpen={onOpen}
          />
        ) : (
          <UnderpassRows
            state={state}
            packageId={packageId}
            itemKey={key as "ham_tuong" | "ham_nap"}
            onChange={onChange}
            onOpen={onOpen}
          />
        )}
      </div>
    </div>
  );
}

function BridgeRows({
  bridges,
  itemKey,
  onOpen,
}: {
  bridges: ProgressV2["bridges"];
  itemKey: BridgeItemKey;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const { t } = useTranslation();
  const supportItem =
    itemKey === "coc" || itemKey === "be" || itemKey === "than" || itemKey === "xm";
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-card">
        <tr>
          <th className="p-2 text-start">
            {supportItem ? t("progress.v2.support") : t("progress.v2.span")}
          </th>
          <th className="p-2 text-start">{t("progress.v2.structure")}</th>
          <th className="p-2 text-end">{t("progress.actual")}</th>
          <th className="p-2 text-end">{t("progress.v2.detailColumn")}</th>
        </tr>
      </thead>
      <tbody>
        {bridges.flatMap((bridge) =>
          supportItem
            ? bridge.supports
                .filter((support) => support.inc)
                .map((support) => {
                  const pct = supportItemPct(support, itemKey as "coc" | "be" | "than" | "xm");
                  const detail =
                    itemKey === "coc"
                      ? `${support.piles.filter((pile) => pile === 2).length}/${support.coc.t} · ${support.piles.filter((pile) => pile === 1).length} ${t("progress.status.wip")}`
                      : `${fmt(pct)}%`;
                  return (
                    <tr
                      key={`${bridge.id}-${support.id}`}
                      className="cursor-pointer border-t border-border hover:bg-muted"
                      onClick={() =>
                        onOpen({ kind: "support", bridgeId: bridge.id, id: support.id })
                      }
                    >
                      <td className="p-2 font-semibold">{support.id}</td>
                      <td className="p-2">{bridge.name}</td>
                      <td className="p-2 text-end tabular-nums">{fmt(pct)}%</td>
                      <td className="p-2 text-end text-muted-foreground">{detail}</td>
                    </tr>
                  );
                })
            : bridge.spans.map((span) => {
                const pct = spanItemPct(span, itemKey as "duc" | "gac" | "bmc" | "ht");
                const detail =
                  itemKey === "duc"
                    ? `${span.girders.filter((girder) => girder.st >= 2).length}/${span.girders.length}`
                    : itemKey === "gac"
                      ? `${span.girders.filter((girder) => girder.st === 5).length}/${span.girders.length} · ${span.girders.filter((girder) => girder.st === 4).length} ${t("progress.v2.ready")}`
                      : `${span.L} m`;
                return (
                  <tr
                    key={`${bridge.id}-${span.id}`}
                    className="cursor-pointer border-t border-border hover:bg-muted"
                    onClick={() => onOpen({ kind: "span", bridgeId: bridge.id, id: span.id })}
                  >
                    <td className="p-2 font-semibold">{span.id}</td>
                    <td className="p-2">{bridge.name}</td>
                    <td className="p-2 text-end tabular-nums">{fmt(pct)}%</td>
                    <td className="p-2 text-end text-muted-foreground">{detail}</td>
                  </tr>
                );
              }),
        )}
      </tbody>
    </table>
  );
}

function RoadRows({
  state,
  packageId,
  itemKey,
  onChange,
  onOpen,
}: {
  state: ProgressV2;
  packageId: string | null;
  itemKey: RoadItemKey;
  onChange: (state: ProgressV2) => void;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const { t } = useTranslation();
  const packageItem = state.packages.find((item) => item.id === packageId);
  const rows = state.road.km.filter(
    (item) =>
      !packageItem ||
      Math.max(item.from, packageItem.fromStation) < Math.min(item.to, packageItem.toStation),
  );
  const setPct = (id: string, value: number) =>
    onChange({
      ...state,
      road: {
        km: state.road.km.map((item) =>
          item.id === id
            ? { ...item, pct: { ...item.pct, [itemKey]: Math.min(100, Math.max(0, value)) } }
            : item,
        ),
      },
    });
  return (
    <table className="w-full text-xs">
      <thead>
        <tr>
          <th className="p-2 text-start">{t("progress.v2.kmSection")}</th>
          <th className="p-2 text-end">{t("progress.v2.from")}</th>
          <th className="p-2 text-end">{t("progress.v2.to")}</th>
          <th className="p-2 text-end">%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => (
          <tr key={item.id} className="border-t border-border">
            <td className="p-2">
              <button
                type="button"
                className="font-semibold hover:underline"
                onClick={() => onOpen({ kind: "km", id: item.id })}
              >
                {item.id}
              </button>
            </td>
            <td className="p-2 text-end">{item.from}</td>
            <td className="p-2 text-end">{item.to}</td>
            <td className="p-2 text-end">
              <input
                aria-label={`${item.id} ${t(`progress.v2.items.${itemKey}`)}`}
                type="number"
                min={0}
                max={100}
                value={item.pct[itemKey]}
                onChange={(event) => setPct(item.id, Number(event.target.value))}
                className="h-7 w-20 border border-input bg-background px-2 text-end"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UnderpassRows({
  state,
  packageId,
  itemKey,
  onChange,
  onOpen,
}: {
  state: ProgressV2;
  packageId: string | null;
  itemKey: "ham_tuong" | "ham_nap";
  onChange: (state: ProgressV2) => void;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const rows = state.underpasses.filter(
    (item) => !packageId || packageForStation(state.packages, item.station)?.id === packageId,
  );
  const field = itemKey === "ham_tuong" ? "tuong" : "nap";
  const setPct = (id: string, value: number) =>
    onChange({
      ...state,
      underpasses: state.underpasses.map((item) =>
        item.id === id
          ? { ...item, pct: { ...item.pct, [field]: Math.min(100, Math.max(0, value)) } }
          : item,
      ),
    });
  return (
    <table className="w-full text-xs">
      <thead>
        <tr>
          <th className="p-2 text-start">ID</th>
          <th className="p-2 text-end">Km</th>
          <th className="p-2 text-end">%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => (
          <tr key={item.id} className="border-t border-border">
            <td className="p-2">
              <button
                type="button"
                className="font-semibold hover:underline"
                onClick={() => onOpen({ kind: "underpass", id: item.id })}
              >
                {item.id}
              </button>
            </td>
            <td className="p-2 text-end">
              {Number.isFinite(item.station)
                ? new Intl.NumberFormat(undefined).format(item.station)
                : "—"}
            </td>
            <td className="p-2 text-end">
              <input
                type="number"
                min={0}
                max={100}
                value={item.pct[field]}
                onChange={(event) => setPct(item.id, Number(event.target.value))}
                className="h-7 w-20 border border-input bg-background px-2 text-end"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
