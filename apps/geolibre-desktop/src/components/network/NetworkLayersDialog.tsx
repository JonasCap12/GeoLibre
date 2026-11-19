import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
} from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import {
  layerConfigPatch,
  layerFieldNames,
  readLayerConfig,
  type NetworkFields,
  type NetworkLayerConfig,
} from "../../lib/network-dashboard";

const FIELDS: (keyof NetworkFields)[] = ["name", "status", "type", "year"];

/**
 * Which line layers take part in the dashboard, and which attribute holds each
 * project's name, status, type and start year. Saved on the layer, so it
 * travels with the project.
 */
export function NetworkLayersDialog({
  open,
  onOpenChange,
  layers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layers: readonly GeoLibreLayer[];
}) {
  const { t } = useTranslation();
  const save = (layer: GeoLibreLayer, patch: Partial<NetworkLayerConfig>) =>
    useAppStore
      .getState()
      .updateLayer(layer.id, layerConfigPatch(layer, { ...readLayerConfig(layer), ...patch }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("roadNetwork.layers.title")}</DialogTitle>
          <DialogDescription>{t("roadNetwork.layers.description")}</DialogDescription>
        </DialogHeader>
        {layers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("roadNetwork.empty.noLines")}</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-start text-xs text-muted-foreground">
                  <th className="p-1 text-start font-medium">{t("roadNetwork.layers.layer")}</th>
                  {FIELDS.map((field) => (
                    <th key={field} className="p-1 text-start font-medium">
                      {t(`roadNetwork.field.${field}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {layers.map((layer) => {
                  const config = readLayerConfig(layer);
                  const names = layerFieldNames(layer);
                  return (
                    <tr key={layer.id} className="border-t align-middle">
                      <td className="p-1">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-primary"
                            checked={config.included}
                            onChange={(event) => save(layer, { included: event.target.checked })}
                          />
                          <span className="max-w-48 truncate" title={layer.name}>
                            {layer.name}
                          </span>
                        </label>
                      </td>
                      {FIELDS.map((field) => (
                        <td key={field} className="p-1">
                          <Select
                            aria-label={`${layer.name}: ${t(`roadNetwork.field.${field}`)}`}
                            className="text-xs"
                            value={config[field]}
                            disabled={!config.included}
                            onChange={(event) => save(layer, { [field]: event.target.value })}
                          >
                            <option value="">{t("roadNetwork.field.none")}</option>
                            {names.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </Select>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
