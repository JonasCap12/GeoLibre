const PACKAGES = ["XL01", "XL02", "XL04", "XL05"] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A saved handle still counts when permission must be requested again. */
export function hasDailyReportSource(handles: unknown, links: unknown): boolean {
  if (typeof links === "string") {
    try {
      links = JSON.parse(links);
    } catch {
      links = null;
    }
  }
  const files = record(record(handles).files);
  const urls = record(links);
  return PACKAGES.some((key) => {
    const handle = files[key];
    const url = urls[key];
    return (
      Boolean(handle && typeof handle === "object" && !Array.isArray(handle)) ||
      (typeof url === "string" && /^https?:\/\//i.test(url.trim()))
    );
  });
}

/** Read only the board's source configuration; never request file permissions here. */
export async function readDailyReportSource(
  host: Pick<Window, "indexedDB" | "localStorage">,
): Promise<boolean | null> {
  let links: string | null;
  try {
    links = host.localStorage.getItem("bcn-links");
  } catch {
    return null;
  }
  if (hasDailyReportSource(null, links)) return true;
  return new Promise((resolve) => {
    try {
      const request = host.indexedDB.open("bcn-bangdien");
      // The board owns its schema. Do not create a parent-owned empty database.
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = request.onblocked = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        const finish = (configured: boolean | null) => {
          db.close();
          resolve(configured);
        };
        try {
          if (!db.objectStoreNames.contains("docs")) {
            finish(null);
            return;
          }
          const transaction = db.transaction("docs", "readonly");
          const value = transaction.objectStore("docs").get("bcn/fh");
          transaction.oncomplete = () => finish(hasDailyReportSource(value.result, links));
          transaction.onerror = transaction.onabort = () => finish(null);
        } catch {
          finish(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

const HINT_DISMISSED_STORAGE = "geolibre-daily-report-hint-dismissed";

/** Whether the viewer has hidden the "how to load reports" hint on this device. */
export function sourceHintDismissed(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(HINT_DISMISSED_STORAGE) === "1";
  } catch {
    return false;
  }
}

/** Remember the dismissal; storage can be unavailable, the hint just returns next time. */
export function dismissSourceHint(storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(HINT_DISMISSED_STORAGE, "1");
  } catch {
    /* Optional preference. */
  }
}

export const NO_REPORT_SOURCE_TOAST =
  "Lỗi chưa có link dữ liệu (⚙ Cài đặt) và chưa có file trong DuLieu";

/** Parent-side integration only; the original HTML and its handlers stay intact. */
export function attachDailyReportAdapter(
  doc: Document,
  readSource: () => Promise<boolean | null>,
  onSource: (configured: boolean | null) => void,
  onReviewChange?: (open: boolean) => void,
): () => void {
  let disposed = false;
  let configured: boolean | null = null;
  let replaying = false;
  let settingsOpen = Boolean(doc.getElementById("setOv"));
  let reviewOpen = Boolean(doc.getElementById("upOv"));
  let refreshId = 0;
  const removeOrphanToast = () => {
    if (configured !== false) return;
    for (const toast of doc.querySelectorAll(".toast")) {
      if (toast.textContent === NO_REPORT_SOURCE_TOAST) toast.remove();
    }
  };
  const refresh = async () => {
    const id = ++refreshId;
    const value = await readSource().catch(() => null);
    if (disposed || id !== refreshId) return value;
    configured = value;
    onSource(value);
    removeOrphanToast();
    return value;
  };
  const click = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const button = target?.closest?.("#bUp") as HTMLElement | null;
    if (!button || replaying) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Re-read on every click: fhPut writes IndexedDB directly, without broadcasting.
    void refresh().then((source) => {
      if (disposed) return;
      if (source === false) doc.getElementById("fileIn")?.click();
      else {
        // Replay once so the board keeps its own sync and permission flow.
        replaying = true;
        try {
          button.click();
        } finally {
          replaying = false;
        }
      }
    });
  };
  const observer = new MutationObserver(() => {
    removeOrphanToast();
    const open = Boolean(doc.getElementById("setOv"));
    if (settingsOpen && !open) void refresh();
    settingsOpen = open;
    const review = Boolean(doc.getElementById("upOv"));
    if (review !== reviewOpen) {
      reviewOpen = review;
      onReviewChange?.(review);
    }
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener("click", click, true);
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel("bcn");
  } catch {
    /* Configuration is also re-read on clicks and when Settings closes. */
  }
  if (channel)
    channel.onmessage = () => {
      void refresh();
    };
  void refresh();
  return () => {
    disposed = true;
    observer.disconnect();
    doc.removeEventListener("click", click, true);
    channel?.close();
  };
}
