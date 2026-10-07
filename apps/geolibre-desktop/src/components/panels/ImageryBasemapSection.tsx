import { IMAGERY_BASEMAPS, type ImageryBasemap } from "@geolibre/core";
import { cn } from "@geolibre/ui";
import { useTranslation } from "react-i18next";

interface ImageryBasemapSectionProps {
  selectedId?: string;
  onSelect: (basemap: ImageryBasemap) => void;
}

/**
 * Keyless satellite imagery, shared by the New Project and Change Basemap
 * panels. Not part of the Regional section: that section is the China-reach
 * catalog.
 */
export function ImageryBasemapSection({ selectedId, onSelect }: ImageryBasemapSectionProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {t("basemapPicker.sectionSatellite")}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {IMAGERY_BASEMAPS.map((basemap) => (
          <button
            key={basemap.id}
            type="button"
            aria-pressed={basemap.id === selectedId}
            className={cn(
              "flex min-h-10 items-center justify-center rounded-md border px-3 py-1.5 text-center text-sm font-medium leading-tight transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              basemap.id === selectedId
                ? "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                : "border-input bg-background",
            )}
            onClick={() => onSelect(basemap)}
          >
            {t(basemap.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
