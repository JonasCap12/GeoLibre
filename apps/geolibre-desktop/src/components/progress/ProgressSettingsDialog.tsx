import type { GeoLibreLayer } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  Textarea,
} from "@geolibre/ui";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cadLayerNames,
  normalizeProgressConfig,
  suggestProgressConfig,
  type ConstructionProgress,
  type ProgressItem,
  type ProgressMeasure,
} from "../../lib/construction-progress";

/**
 * Edit a drawing's progress setup: the header text, the work items (name,
 * weight, which CAD layers they gather, how they are measured, plan and an
 * optional hand-entered percent) and the issue notes. Nothing is written
 * until Save, which goes through `updateLayer` so undo, saving and
 * collaboration see one edit.
 */

const MEASURES: ProgressMeasure[] = ["count", "length", "area"];

function numberOrNull(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function nextKey(items: ProgressItem[]): string {
  const used = new Set(items.map((item) => item.key));
  let n = items.length + 1;
  while (used.has(`item-${n}`)) n += 1;
  return `item-${n}`;
}

export function ProgressSettingsDialog({
  layer,
  config,
  onClose,
  onSave,
}: {
  layer: GeoLibreLayer;
  config: ConstructionProgress;
  onClose: () => void;
  onSave: (next: ConstructionProgress) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ConstructionProgress>(config);
  const [openItem, setOpenItem] = useState<string | null>(null);
  // Rebuilding the items reuses keys; a new generation resets the rows' typed text.
  const [generation, setGeneration] = useState(0);
  const features = useMemo(() => layer.geojson?.features ?? [], [layer.geojson]);
  const cadLayers = useMemo(() => cadLayerNames(features), [features]);

  const patchItem = (key: string, patch: Partial<ProgressItem>) =>
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    }));

  const toggleCadLayer = (item: ProgressItem, name: string) =>
    patchItem(item.key, {
      cadLayers: item.cadLayers.includes(name)
        ? item.cadLayers.filter((value) => value !== name)
        : [...item.cadLayers, name],
    });

  const addItem = () => {
    const key = nextKey(draft.items);
    setOpenItem(key);
    setDraft((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          key,
          name: t("progress.newItem"),
          weight: 1,
          cadLayers: [],
          measure: "count",
          plannedPct: 0,
          overridePct: null,
        },
      ],
    }));
  };

  const resuggest = () => {
    setGeneration((n) => n + 1);
    setDraft((current) => ({
      ...current,
      items: suggestProgressConfig(features, current.title).items,
    }));
  };

  const save = () => {
    // Normalising drops unnamed items and clamps percents, as a reload would.
    const next = normalizeProgressConfig(draft);
    if (next) onSave(next);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("progress.settingsTitle")}</DialogTitle>
          <DialogDescription>{t("progress.settingsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-1">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="progress-title">{t("progress.field.title")}</Label>
              <Input
                id="progress-title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="progress-subtitle">{t("progress.field.subtitle")}</Label>
              <Input
                id="progress-subtitle"
                value={draft.subtitle}
                onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t("progress.items")}</h3>
            <div className="flex gap-1">
              <Button type="button" size="sm" variant="outline" onClick={resuggest}>
                <RotateCcw className="me-1.5 h-3.5 w-3.5" />
                {t("progress.resuggest")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={addItem}>
                <Plus className="me-1.5 h-3.5 w-3.5" />
                {t("progress.addItem")}
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-start text-muted-foreground">
                  <th className="p-1 text-start font-medium">{t("progress.field.name")}</th>
                  <th className="w-16 p-1 text-start font-medium">{t("progress.field.weight")}</th>
                  <th className="w-28 p-1 text-start font-medium">{t("progress.field.measure")}</th>
                  <th className="w-16 p-1 text-start font-medium">{t("progress.field.plan")}</th>
                  <th className="w-20 p-1 text-start font-medium">
                    {t("progress.field.override")}
                  </th>
                  <th className="w-24 p-1 text-start font-medium">
                    {t("progress.field.cadLayers")}
                  </th>
                  <th className="w-8 p-1">
                    <span className="sr-only">{t("progress.removeItem")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.items.map((item) => (
                  <ItemRows
                    key={`${generation}:${item.key}`}
                    item={item}
                    cadLayers={cadLayers}
                    expanded={openItem === item.key}
                    onToggleExpanded={() =>
                      setOpenItem((current) => (current === item.key ? null : item.key))
                    }
                    onPatch={(patch) => patchItem(item.key, patch)}
                    onToggleCadLayer={(name) => toggleCadLayer(item, name)}
                    onRemove={() =>
                      setDraft((current) => ({
                        ...current,
                        items: current.items.filter((other) => other.key !== item.key),
                      }))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="progress-notes">{t("progress.field.notes")}</Label>
            <Textarea
              id="progress-notes"
              rows={4}
              value={draft.notes}
              placeholder={t("progress.field.notesHint")}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ItemRows({
  item,
  cadLayers,
  expanded,
  onToggleExpanded,
  onPatch,
  onToggleCadLayer,
  onRemove,
}: {
  item: ProgressItem;
  cadLayers: string[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onPatch: (patch: Partial<ProgressItem>) => void;
  onToggleCadLayer: (name: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  // Keep the typed text while editing, so "1," or an empty box is not
  // snapped back to a number on every keystroke.
  const [weight, setWeight] = useState(String(item.weight));
  const [plan, setPlan] = useState(String(item.plannedPct));
  const [override, setOverride] = useState(
    item.overridePct === null ? "" : String(item.overridePct),
  );
  // CAD layers a stored item names but this drawing no longer has stay listed.
  const choices = [...cadLayers, ...item.cadLayers.filter((name) => !cadLayers.includes(name))];
  return (
    <>
      <tr className="border-t border-border align-middle">
        <td className="p-1">
          <Input
            aria-label={t("progress.field.name")}
            className="h-8 text-xs"
            value={item.name}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </td>
        <td className="p-1">
          <Input
            aria-label={t("progress.field.weight")}
            inputMode="decimal"
            className="h-8 text-xs"
            value={weight}
            onChange={(e) => {
              setWeight(e.target.value);
              const n = numberOrNull(e.target.value);
              if (n !== null) onPatch({ weight: Math.max(0, n) });
            }}
          />
        </td>
        <td className="p-1">
          <Select
            aria-label={t("progress.field.measure")}
            className="text-xs"
            value={item.measure}
            onChange={(e) => onPatch({ measure: e.target.value as ProgressMeasure })}
          >
            {MEASURES.map((measure) => (
              <option key={measure} value={measure}>
                {t(`progress.measure.${measure}`)}
              </option>
            ))}
          </Select>
        </td>
        <td className="p-1">
          <Input
            aria-label={t("progress.field.plan")}
            inputMode="decimal"
            className="h-8 text-xs"
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value);
              const n = numberOrNull(e.target.value);
              onPatch({ plannedPct: n ?? 0 });
            }}
          />
        </td>
        <td className="p-1">
          <Input
            aria-label={t("progress.field.override")}
            inputMode="decimal"
            className="h-8 text-xs"
            placeholder={t("progress.field.overrideAuto")}
            value={override}
            onChange={(e) => {
              setOverride(e.target.value);
              onPatch({ overridePct: numberOrNull(e.target.value) });
            }}
          />
        </td>
        <td className="p-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={expanded}
            className="h-8 w-full justify-start px-2 text-xs"
            onClick={onToggleExpanded}
          >
            {t("progress.cadLayerCount", { count: item.cadLayers.length })}
          </Button>
        </td>
        <td className="p-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t("progress.removeItem")}
            title={t("progress.removeItem")}
            className="h-8 w-8 p-0"
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7} className="p-1 pt-0">
            <div className="flex flex-wrap gap-1 rounded-sm bg-muted/50 p-1.5">
              {choices.length === 0 ? (
                <span className="text-muted-foreground">{t("progress.noCadLayers")}</span>
              ) : null}
              {choices.map((name) => {
                const on = item.cadLayers.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onToggleCadLayer(name)}
                    className={`rounded-sm border px-1.5 py-0.5 ${
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background hover:bg-muted"
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
