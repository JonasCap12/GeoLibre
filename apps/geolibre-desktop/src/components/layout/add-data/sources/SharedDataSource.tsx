import { Button, Label, Select } from "@geolibre/ui";
import { Download, FileUp, RefreshCw, Trash2, Upload, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../../../hooks/useDesktopSettings";
import { loadDuckDbVectorFile } from "../../../../lib/duckdb-vector-loader";
import {
  deleteSharedDataset,
  fetchSharedDatasetBytes,
  formatDatasetSize,
  listSharedDatasets,
  type SharedDataset,
  uploadSharedDataset,
} from "../../../../lib/shared-datasets";
import { openLocalDataFileWithFallback } from "../../../../lib/tauri-io";
import { createBaseLayer, errorMessage, fileNameFromPath } from "../helpers";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/** The extension DuckDB uses to pick a reader, lowercased and without the dot. */
function extensionOf(filename: string): string {
  const match = /\.([^.\\/]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

/**
 * The shared data library: files one member of a team uploads once, which
 * everyone else can then add to their map.
 *
 * It is the counterpart to the Layer Library in the Browser panel, which stores
 * datasets in this browser's IndexedDB where nobody else can reach them. Here
 * the bytes live on the deployment's own projects API, so converting a large
 * drawing is work the team does once rather than once per person.
 *
 * Loading a dataset hands the bytes to the same vector reader the file picker
 * uses, so every format the app supports locally works from the library too.
 */
export function SharedDataSource() {
  const { t } = useTranslation();
  const [defaultName] = useState(() => t("addData.sharedData.defaultName"));
  const source = useAddDataSource(defaultName);
  const token = (useDesktopSettingsStore((s) => s.desktopSettings.shareToken) ?? "").trim();

  const [datasets, setDatasets] = useState<SharedDataset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isListing, setIsListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  // Bumped on every refresh so a slow listing that resolves after a newer one
  // cannot overwrite the newer result.
  const listSeq = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++listSeq.current;
    setIsListing(true);
    setListError(null);
    try {
      const entries = await listSharedDatasets({ token: token || undefined });
      if (requestId !== listSeq.current) return;
      setDatasets(entries);
      setSelectedId((current) =>
        current !== null && entries.some((entry) => entry.id === current)
          ? current
          : (entries[0]?.id ?? null),
      );
    } catch (err) {
      if (requestId === listSeq.current) {
        setListError(errorMessage(err, t("addData.sharedData.listError")));
      }
    } finally {
      if (requestId === listSeq.current) setIsListing(false);
    }
  }, [t, token]);

  // Load once on open, and again whenever the token changes: signing in reveals
  // the caller's own private uploads, which an anonymous listing omits.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = datasets.find((entry) => entry.id === selectedId) ?? null;

  const handleUpload = async () => {
    if (!token) {
      setUploadNote(t("addData.sharedData.tokenRequired"));
      return;
    }
    setUploadNote(null);
    const picked = await openLocalDataFileWithFallback({
      // Any file the library might hold; the reader is chosen by extension when
      // the dataset is added, not here.
      filters: [{ name: t("addData.sharedData.fileFilter"), extensions: ["*"] }],
      accept: "*/*",
      readBinary: true,
    }).catch(
      (err: unknown) => {
        setUploadNote(errorMessage(err, t("addData.sharedData.uploadError")));
        return null;
      },
    );
    if (!picked?.data) return;

    const filename = fileNameFromPath(picked.path);
    setIsUploading(true);
    try {
      const stored = await uploadSharedDataset({
        token,
        data: new Uint8Array(picked.data),
        filename,
      });
      setUploadNote(t("addData.sharedData.uploaded", { name: stored.name }));
      await refresh();
      setSelectedId(stored.id);
    } catch (err) {
      setUploadNote(errorMessage(err, t("addData.sharedData.uploadError")));
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || !token) return;
    setUploadNote(null);
    try {
      await deleteSharedDataset(selected.id, { token });
      await refresh();
    } catch (err) {
      setUploadNote(errorMessage(err, t("addData.sharedData.deleteError")));
    }
  };

  const handleSubmit = source.runSubmit(async () => {
    if (!selected) throw new Error(t("addData.sharedData.errorChoose"));
    const bytes = await fetchSharedDatasetBytes(selected.id, { token: token || undefined });

    // Read through the same DuckDB vector path the file picker uses, so every
    // format the app opens locally opens from the library too, with one reader
    // rather than a second, narrower one.
    const featureCollection = await loadDuckDbVectorFile({
      name: selected.filename,
      extension: extensionOf(selected.filename),
      data: bytes,
    });

    const name = source.layerName.trim() || selected.name;
    source.addAndClose(
      {
        ...createBaseLayer(
          name,
          "geojson",
          { type: "geojson" },
          {
            sourceKind: "shared-data",
            sharedDatasetId: selected.id,
            featureCount: featureCollection.features.length,
          },
          { geojson: featureCollection },
        ),
        geojson: featureCollection,
      },
      { fit: true },
    );
  });

  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={handleSubmit}
      error={source.error}
      submitDisabled={source.isSubmitting || isListing || selected === null}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="shared-dataset">
            <Users className="me-1 inline h-3.5 w-3.5 align-text-bottom" />
            {t("addData.sharedData.dataset")}
          </Label>
          <Select
            id="shared-dataset"
            value={selectedId ?? ""}
            disabled={isListing || datasets.length === 0}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {datasets.length === 0 ? (
              <option value="">
                {isListing
                  ? t("addData.sharedData.loading")
                  : t("addData.sharedData.emptyLibrary")}
              </option>
            ) : (
              datasets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t("addData.sharedData.datasetOption", {
                    name: entry.name,
                    size: formatDatasetSize(entry.sizeBytes),
                    owner: entry.owner ?? t("addData.sharedData.unknownOwner"),
                  })}
                </option>
              ))
            )}
          </Select>
          {selected ? (
            <p className="text-xs text-muted-foreground">
              {t("addData.sharedData.datasetDetail", {
                filename: selected.filename,
                downloads: selected.downloads,
              })}
            </p>
          ) : null}
          {listError ? <p className="text-xs text-destructive">{listError}</p> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => void refresh()} disabled={isListing}>
            <RefreshCw className="me-2 h-3.5 w-3.5" />
            {t("addData.sharedData.refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleUpload()}
            disabled={isUploading || !token}
          >
            {isUploading ? (
              <Upload className="me-2 h-3.5 w-3.5" />
            ) : (
              <FileUp className="me-2 h-3.5 w-3.5" />
            )}
            {isUploading ? t("addData.sharedData.uploading") : t("addData.sharedData.upload")}
          </Button>
          {selected && token ? (
            <Button type="button" variant="outline" onClick={() => void handleDelete()}>
              <Trash2 className="me-2 h-3.5 w-3.5" />
              {t("addData.sharedData.delete")}
            </Button>
          ) : null}
        </div>

        {uploadNote ? <p className="text-xs text-muted-foreground">{uploadNote}</p> : null}
        <p className="text-xs text-muted-foreground">
          <Download className="me-1 inline h-3 w-3 align-text-bottom" />
          {token ? t("addData.sharedData.help") : t("addData.sharedData.helpAnonymous")}
        </p>
      </div>
    </AddDataSourceForm>
  );
}
