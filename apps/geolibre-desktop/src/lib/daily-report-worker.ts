/**
 * Runs the embedded board's manual Excel import off its UI thread.
 *
 * The board (`public/daily-report/index.html`, never edited) reads dropped or
 * picked files with `window.BCN.parseWorkbook` on its own main thread, so a
 * 100–250 MB workbook freezes the page for tens of seconds. Its synced-file
 * path already uses a worker; this gives the manual path the same: the
 * parent swaps `BCN.parseWorkbook` for a version that runs the board's own
 * scripts (SheetJS, JSZip and the engine, read from its `<script>` tags) in a
 * worker created in the board's realm, so the board's CSP (`worker-src blob:`)
 * applies. Anything unexpected falls back to the original function.
 */

/** The board's inline scripts the parser needs, by element id, in load order. */
export const BOARD_PARSER_SCRIPTS = ["lib-xlsx", "lib-jszip", "bcn-engine"] as const;

/** The only options a manual import passes; other calls (the sync fallback) carry parser state. */
const PLAIN_OPTIONS = new Set(["XLSX", "JSZip", "fileName"]);

const WORKER_MAIN = `
self.onmessage = async (event) => {
  const { id, buf, fileName } = event.data;
  let result;
  try {
    result = await self.BCN.parseWorkbook(buf, { XLSX: self.XLSX, JSZip: self.JSZip, fileName });
  } catch (error) {
    self.postMessage({ id, ok: false, message: (error && error.message) || String(error) });
    return;
  }
  // Hand image bytes back without copying them.
  const buffers = new Set();
  for (const image of (result && result.images) || []) {
    if (image && image.bytes && image.bytes.buffer) buffers.add(image.bytes.buffer);
  }
  try {
    self.postMessage({ id, ok: true, result }, [...buffers]);
  } catch (error) {
    self.postMessage({ id, ok: false, fallback: true });
  }
};`;

type Parse = (buf: Uint8Array, options?: unknown) => Promise<unknown>;

/** The board iframe's window: its engine global and the constructors of its realm. */
export interface BoardWindow {
  BCN?: { parseWorkbook?: Parse };
  document: Document;
  Worker: typeof Worker;
  Blob: typeof Blob;
  URL: typeof URL;
  Error: ErrorConstructor;
}

interface Reply {
  ok: boolean;
  result?: unknown;
  message?: string;
  /** Run it on the board's thread after all (a worker failure, an uncloneable result). */
  fallback?: boolean;
}

/** The worker script: the board's parser libraries, then the message handler; null if any is missing. */
export function boardWorkerSource(doc: Pick<Document, "getElementById">): string | null {
  const parts: string[] = [];
  for (const id of BOARD_PARSER_SCRIPTS) {
    const text = doc.getElementById(id)?.textContent ?? "";
    if (!text.trim()) return null;
    parts.push(text);
  }
  return [...parts, WORKER_MAIN].join("\n;\n");
}

/** Whether a `parseWorkbook` call is a plain manual import (only libraries and a file name). */
export function isPlainImport(options: unknown): options is { fileName: string } {
  if (!options || typeof options !== "object") return false;
  const record = options as Record<string, unknown>;
  return (
    typeof record.fileName === "string" &&
    Object.keys(record).every((key) => PLAIN_OPTIONS.has(key))
  );
}

/**
 * Route the board's manual imports through a worker. Returns a function that
 * restores the original parser and stops the worker.
 */
export function offloadBoardParsing(board: BoardWindow): () => void {
  const engine = board.BCN;
  const original = engine?.parseWorkbook;
  const source =
    engine && typeof original === "function" ? boardWorkerSource(board.document) : null;
  if (!engine || !original || !source) return () => {};

  let worker: Worker | null = null;
  let failed = false;
  let url: string | null = null;
  let next = 0;
  const pending = new Map<number, (reply: Reply) => void>();
  const failAll = () => {
    for (const settle of pending.values()) settle({ ok: false, fallback: true });
    pending.clear();
  };
  const start = (): Worker | null => {
    if (worker || failed) return worker;
    try {
      url = board.URL.createObjectURL(new board.Blob([source], { type: "text/javascript" }));
      const created = new board.Worker(url);
      created.onmessage = (event: MessageEvent<Reply & { id: number }>) => {
        const settle = pending.get(event.data.id);
        pending.delete(event.data.id);
        settle?.(event.data);
      };
      created.onerror = () => {
        failed = true;
        created.terminate();
        worker = null;
        failAll();
      };
      worker = created;
    } catch {
      failed = true;
    }
    return worker;
  };

  const parse: Parse = (buf, options) => {
    const running = isPlainImport(options) ? start() : null;
    if (!running || !isPlainImport(options)) return original.call(engine, buf, options);
    return new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, (reply) => {
        if (reply.ok) resolve(reply.result);
        else if (reply.fallback) resolve(original.call(engine, buf, options));
        else reject(new board.Error(reply.message ?? "parseWorkbook"));
      });
      // Copied, not transferred: the board's thread keeps the bytes for a fallback.
      running.postMessage({ id, buf, fileName: options.fileName });
    });
  };
  engine.parseWorkbook = parse;

  return () => {
    if (engine.parseWorkbook === parse) engine.parseWorkbook = original;
    worker?.terminate();
    worker = null;
    // The board is going away: nothing is left to deliver a result to.
    pending.clear();
    if (url) board.URL.revokeObjectURL(url);
  };
}
