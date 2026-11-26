import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOARD_PARSER_SCRIPTS,
  boardWorkerSource,
  isPlainImport,
  offloadBoardParsing,
  type BoardWindow,
} from "../apps/geolibre-desktop/src/lib/daily-report-worker";

type Reply = { id: number; ok: boolean; result?: unknown; message?: string; fallback?: boolean };

/** A board window whose Worker answers with `respond`, recording what it was sent. */
function fakeBoard(respond: (message: { id: number; fileName: string }) => Reply | "crash" | null) {
  const scripts = new Map<string, string>(BOARD_PARSER_SCRIPTS.map((id) => [id, `/* ${id} */`]));
  const sent: { id: number; fileName: string; buf: Uint8Array }[] = [];
  const workers: FakeWorker[] = [];
  const revoked: string[] = [];
  const originalCalls: unknown[] = [];
  class FakeWorker {
    onmessage: ((event: { data: Reply }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor(readonly url: string) {
      workers.push(this);
    }
    postMessage(message: { id: number; fileName: string; buf: Uint8Array }) {
      sent.push(message);
      const reply = respond(message);
      queueMicrotask(() => {
        if (reply === "crash") this.onerror?.();
        else if (reply) this.onmessage?.({ data: reply });
      });
    }
    terminate() {
      this.terminated = true;
    }
  }
  const original = async (_buf: Uint8Array, options?: unknown) => {
    originalCalls.push(options);
    return { from: "board thread" };
  };
  const board = {
    BCN: { parseWorkbook: original },
    document: {
      getElementById: (id: string) => (scripts.has(id) ? { textContent: scripts.get(id) } : null),
    },
    Worker: FakeWorker,
    Blob: class {
      constructor(readonly parts: string[]) {}
    },
    URL: {
      createObjectURL: () => "blob:worker",
      revokeObjectURL: (url: string) => revoked.push(url),
    },
    Error,
  } as unknown as BoardWindow;
  return { board, sent, workers, revoked, originalCalls, original, scripts };
}

const XLSX = {};
const JSZip = {};
const plain = (fileName = "EC02.xlsx") => ({ XLSX, JSZip, fileName });

describe("daily report board: manual imports off the UI thread", () => {
  it("recognizes only a manual import's options", () => {
    assert.equal(isPlainImport(plain()), true);
    assert.equal(isPlainImport({ fileName: "a.xlsx" }), true);
    // The sync fallback passes parser state that cannot cross threads.
    assert.equal(isPlainImport({ ...plain(), sheets: {}, zip: {}, goi: "XL02" }), false);
    assert.equal(isPlainImport({ XLSX }), false);
    assert.equal(isPlainImport(null), false);
    assert.equal(isPlainImport("a.xlsx"), false);
  });

  it("builds the worker from the board's own scripts, or not at all when one is missing", () => {
    const { board, scripts } = fakeBoard(() => null);
    const source = boardWorkerSource(board.document)!;
    for (const id of BOARD_PARSER_SCRIPTS) assert.ok(source.includes(`/* ${id} */`));
    assert.ok(source.indexOf("lib-xlsx") < source.indexOf("bcn-engine"));
    assert.match(source, /self\.BCN\.parseWorkbook/);
    scripts.set("bcn-engine", "  ");
    assert.equal(boardWorkerSource(board.document), null);
  });

  it("parses a manual import in the worker and keeps the bytes for the board", async () => {
    const fake = fakeBoard(({ id }) => ({ id, ok: true, result: { goi: "XL02" } }));
    const restore = offloadBoardParsing(fake.board);
    const buf = new Uint8Array([1, 2, 3]);
    const result = await fake.board.BCN!.parseWorkbook!(buf, plain());
    assert.deepEqual(result, { goi: "XL02" });
    assert.equal(fake.sent[0].fileName, "EC02.xlsx");
    assert.equal(fake.originalCalls.length, 0);
    assert.equal(buf.byteLength, 3, "copied, not transferred");
    // One worker serves every file.
    await fake.board.BCN!.parseWorkbook!(buf, plain("EC04.xlsx"));
    assert.equal(fake.workers.length, 1);
    restore();
    assert.equal(fake.board.BCN!.parseWorkbook, fake.original);
    assert.equal(fake.workers[0].terminated, true);
    assert.deepEqual(fake.revoked, ["blob:worker"]);
  });

  it("leaves calls with parser state on the board's thread", async () => {
    const fake = fakeBoard(() => null);
    offloadBoardParsing(fake.board);
    const options = { ...plain(), sheets: {}, zip: {} };
    assert.deepEqual(await fake.board.BCN!.parseWorkbook!(new Uint8Array(1), options), {
      from: "board thread",
    });
    assert.equal(fake.sent.length, 0);
    assert.equal(fake.workers.length, 0, "no worker until a manual import");
  });

  it("reports a workbook error as the board expects", async () => {
    const fake = fakeBoard(({ id }) => ({ id, ok: false, message: "Không tìm thấy sheet ngày" }));
    offloadBoardParsing(fake.board);
    await assert.rejects(fake.board.BCN!.parseWorkbook!(new Uint8Array(1), plain()), {
      message: "Không tìm thấy sheet ngày",
    });
    assert.equal(fake.originalCalls.length, 0);
  });

  it("falls back to the board's thread when the result cannot cross or the worker dies", async () => {
    const uncloneable = fakeBoard(({ id }) => ({ id, ok: false, fallback: true }));
    offloadBoardParsing(uncloneable.board);
    assert.deepEqual(await uncloneable.board.BCN!.parseWorkbook!(new Uint8Array(1), plain()), {
      from: "board thread",
    });

    const crashing = fakeBoard(() => "crash");
    offloadBoardParsing(crashing.board);
    assert.deepEqual(await crashing.board.BCN!.parseWorkbook!(new Uint8Array(1), plain()), {
      from: "board thread",
    });
    assert.equal(crashing.workers[0].terminated, true);
    // After a crash every later import stays on the board's thread.
    await crashing.board.BCN!.parseWorkbook!(new Uint8Array(1), plain());
    assert.equal(crashing.workers.length, 1);
    assert.equal(crashing.originalCalls.length, 2);
  });

  it("does nothing when the board has no engine or its scripts are missing", () => {
    const fake = fakeBoard(() => null);
    const noEngine = { ...fake.board, BCN: undefined } as unknown as BoardWindow;
    offloadBoardParsing(noEngine)();
    fake.scripts.delete("lib-jszip");
    const restore = offloadBoardParsing(fake.board);
    assert.equal(fake.board.BCN!.parseWorkbook, fake.original);
    restore();
  });
});
