import { Button } from "@geolibre/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { attachDailyReportAdapter, readDailyReportSource } from "../../lib/daily-report-board";

export function DailyReportBoard({ hidden }: { hidden: boolean }) {
  const { t } = useTranslation();
  const board = useRef<HTMLIFrameElement>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [filePicker, setFilePicker] = useState(false);
  useEffect(() => {
    const observer = new MutationObserver(() => syncTheme(board.current));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      cleanup.current?.();
    };
  }, []);
  return (
    <section
      className="network-dashboard-board bg-background"
      hidden={hidden}
      aria-label={t("roadNetwork.boardTitle")}
    >
      {configured === false && (
        <div
          className="network-dashboard-source-hint border-b bg-card px-3 py-2 text-sm"
          role="status"
        >
          <p className="font-medium">{t("roadNetwork.sourceHint.title")}</p>
          <p className="text-xs text-muted-foreground">{t("roadNetwork.sourceHint.detail")}</p>
          {!filePicker && (
            <p className="text-xs text-muted-foreground">
              {t("roadNetwork.sourceHint.unsupported")}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => board.current?.contentDocument?.getElementById("fileIn")?.click()}
            >
              {t("roadNetwork.sourceHint.upload")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!filePicker}
              onClick={() => board.current?.contentDocument?.getElementById("bSet")?.click()}
            >
              {t("roadNetwork.sourceHint.configure")}
            </Button>
          </div>
        </div>
      )}
      <div className="network-dashboard-frame-box">
        <iframe
          ref={board}
          src={`${import.meta.env.BASE_URL}daily-report/index.html`}
          title={t("roadNetwork.boardTitle")}
          allow="fullscreen"
          onLoad={() => {
            cleanup.current?.();
            const doc = board.current?.contentDocument;
            const host = board.current?.contentWindow;
            if (!doc || !host) return;
            const style = doc.createElement("style");
            style.textContent = "#bX { display: none !important; }";
            doc.head.appendChild(style);
            syncTheme(board.current);
            setFilePicker(
              typeof (host as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker ===
                "function",
            );
            cleanup.current = attachDailyReportAdapter(
              doc,
              () => readDailyReportSource(host),
              setConfigured,
            );
          }}
        />
      </div>
    </section>
  );
}

function syncTheme(frame: HTMLIFrameElement | null) {
  frame?.contentDocument?.documentElement.setAttribute(
    "data-theme",
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
}
