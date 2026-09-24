import { Cloud, CloudOff, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CloudWorkspaceState } from "../../hooks/useCloudWorkspace";

interface CloudWorkspaceStatusProps {
  state: CloudWorkspaceState;
}

/** Short-lived save feedback plus a persistent, visible cloud failure. */
export function CloudWorkspaceStatus({ state }: CloudWorkspaceStatusProps) {
  const { t } = useTranslation();
  if (state.status === "disabled" || state.status === "ready") return null;

  const busy = state.status === "loading" || state.status === "saving";
  const failed = state.status === "error";
  const label =
    state.status === "loading"
      ? t("cloudWorkspace.loading")
      : state.status === "saving"
        ? t("cloudWorkspace.saving")
        : state.status === "saved"
          ? t("cloudWorkspace.saved")
          : t("cloudWorkspace.error");

  return (
    <div
      className={`pointer-events-auto absolute end-2 top-2 z-20 flex max-w-72 items-center gap-1.5 rounded-md border map-glass px-2.5 py-1.5 text-xs font-medium shadow-sm ${
        failed ? "border-destructive/50 text-destructive" : "text-foreground"
      }`}
      role={failed ? "alert" : "status"}
      title={state.error ?? label}
      data-testid="cloud-workspace-status"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : failed ? (
        <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Cloud className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      )}
      <span>{label}</span>
    </div>
  );
}
