import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from "@geolibre/ui";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PROGRESS_V2_ITEM_KEYS, normalizeProgressV2, type ProgressV2 } from "../../lib/progress-v2";

export function ProgressV2SettingsDialog({
  state,
  onClose,
  onSave,
}: {
  state: ProgressV2;
  onClose: () => void;
  onSave: (state: ProgressV2) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(state);
  const number = (value: string) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const patchPackage = (id: string, patch: Partial<ProgressV2["packages"][number]>) =>
    setDraft((current) => ({
      ...current,
      packages: current.packages.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  const save = () => {
    const normalized = normalizeProgressV2(draft);
    if (normalized) onSave(normalized);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("progress.settingsTitle")}</DialogTitle>
          <DialogDescription>{t("progress.v2.settingsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 text-xs">
          <section>
            <h3 className="mb-2 font-bold uppercase text-primary">{t("progress.v2.meta")}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <TextField
                label={t("progress.field.title")}
                value={draft.meta.title}
                onChange={(value) => setDraft({ ...draft, meta: { ...draft.meta, title: value } })}
              />
              <TextField
                label={t("progress.field.subtitle")}
                value={draft.meta.subtitle}
                onChange={(value) =>
                  setDraft({ ...draft, meta: { ...draft.meta, subtitle: value } })
                }
              />
              <TextField
                type="date"
                label={t("progress.v2.reportDate")}
                value={draft.meta.reportDate}
                onChange={(value) =>
                  setDraft({ ...draft, meta: { ...draft.meta, reportDate: value } })
                }
              />
              {(["duan", "cdt", "tvtk", "dv"] as const).map((key) => (
                <TextField
                  key={key}
                  label={t(`progress.v2.metaField.${key}`)}
                  value={draft.meta[key] ?? ""}
                  onChange={(value) =>
                    setDraft({ ...draft, meta: { ...draft.meta, [key]: value } })
                  }
                />
              ))}
            </div>
          </section>
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-bold uppercase text-primary">{t("progress.v2.packages")}</h3>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const index = draft.packages.length + 1;
                  setDraft({
                    ...draft,
                    packages: [
                      ...draft.packages,
                      {
                        id: `package-${Date.now()}`,
                        name: `${t("progress.v2.package")} ${index}`,
                        fromStation: 0,
                        toStation: 0,
                      },
                    ],
                  });
                }}
              >
                <Plus className="me-1 h-3.5 w-3.5" />
                {t("progress.v2.addPackage")}
              </Button>
            </div>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="p-1 text-start">{t("progress.field.name")}</th>
                  <th className="p-1 text-start">{t("progress.v2.from")}</th>
                  <th className="p-1 text-start">{t("progress.v2.to")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.packages.map((item) => (
                  <tr key={item.id} className="border-t border-border">
                    <td className="p-1">
                      <Input
                        value={item.name}
                        className="h-8"
                        onChange={(event) => patchPackage(item.id, { name: event.target.value })}
                      />
                    </td>
                    <td className="p-1">
                      <Input
                        type="number"
                        value={item.fromStation}
                        className="h-8"
                        onChange={(event) =>
                          patchPackage(item.id, { fromStation: number(event.target.value) })
                        }
                      />
                    </td>
                    <td className="p-1">
                      <Input
                        type="number"
                        value={item.toStation}
                        className="h-8"
                        onChange={(event) =>
                          patchPackage(item.id, { toStation: number(event.target.value) })
                        }
                      />
                    </td>
                    <td>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={t("progress.v2.removePackage")}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            packages: draft.packages.filter((value) => value.id !== item.id),
                          })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h3 className="mb-2 font-bold uppercase text-primary">
              {t("progress.v2.weightsPlan")}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="p-1 text-start">{t("progress.items")}</th>
                    <th className="p-1 text-end">{t("progress.field.weight")}</th>
                    {draft.packages.map((item) => (
                      <th key={item.id} className="p-1 text-end">
                        {item.name} %
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PROGRESS_V2_ITEM_KEYS.map((key) => (
                    <tr key={key} className="border-t border-border">
                      <td className="p-1 font-semibold">{t(`progress.v2.items.${key}`)}</td>
                      <td className="p-1 text-end">
                        <Input
                          type="number"
                          min={0}
                          value={draft.weights[key]}
                          className="ms-auto h-8 w-20 text-end"
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              weights: {
                                ...draft.weights,
                                [key]: Math.max(0, number(event.target.value)),
                              },
                            })
                          }
                        />
                      </td>
                      {draft.packages.map((item) => (
                        <td key={item.id} className="p-1 text-end">
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            value={draft.plan[item.id]?.[key] ?? 0}
                            className="ms-auto h-8 w-20 text-end"
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                plan: {
                                  ...draft.plan,
                                  [item.id]: {
                                    ...draft.plan[item.id],
                                    [key]: number(event.target.value),
                                  },
                                },
                              })
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h3 className="mb-2 font-bold uppercase text-primary">{t("progress.v2.yard.title")}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {draft.bridges.map((bridge) => (
                <label key={bridge.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{bridge.name}</span>
                  <Input
                    aria-label={`${bridge.name} ${t("progress.v2.beds")}`}
                    type="number"
                    min={0}
                    value={bridge.yard.beds}
                    className="h-8 w-20"
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        bridges: draft.bridges.map((item) =>
                          item.id === bridge.id
                            ? {
                                ...item,
                                yard: { beds: Math.max(0, Math.round(number(event.target.value))) },
                              }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </section>
          <section>
            <Label htmlFor="progress-v2-notes">{t("progress.v2.note")}</Label>
            <Textarea
              id="progress-v2-notes"
              rows={4}
              value={draft.notes}
              onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            />
          </section>
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

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span>{label}</span>
      <Input
        type={type}
        value={value}
        className="h-8"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
