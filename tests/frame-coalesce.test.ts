import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFrameCoalescer, type FrameScheduler } from "../packages/ui/src/lib/frame-coalesce";

function fakeScheduler(): FrameScheduler & { fire: () => void; readonly pending: number } {
  const queued: Array<() => void> = [];
  let waiting = 0;
  return {
    get pending() {
      return waiting;
    },
    request(callback: () => void) {
      queued.push(callback);
      waiting += 1;
      return queued.length;
    },
    cancel() {
      queued.length = 0;
      waiting = 0;
    },
    fire() {
      const batch = queued.splice(0);
      waiting = 0;
      for (const callback of batch) callback();
    },
  };
}

describe("frame coalescer", () => {
  it("forwards a burst once per frame, keeping the last value", () => {
    const scheduler = fakeScheduler();
    const forwarded: string[] = [];
    const coalescer = createFrameCoalescer((value: string) => {
      forwarded.push(value);
    }, scheduler);
    for (const value of ["#111111", "#222222", "#333333"]) coalescer.push(value);
    assert.equal(scheduler.pending, 1);
    assert.deepEqual(forwarded, []);
    scheduler.fire();
    assert.deepEqual(forwarded, ["#333333"]);
    coalescer.push("#444444");
    scheduler.fire();
    assert.deepEqual(forwarded, ["#333333", "#444444"]);
  });

  it("flushes a waiting value immediately and only once", () => {
    const scheduler = fakeScheduler();
    const forwarded: string[] = [];
    const coalescer = createFrameCoalescer((value: string) => {
      forwarded.push(value);
    }, scheduler);
    coalescer.push("#abcdef");
    coalescer.flush();
    scheduler.fire();
    coalescer.flush();
    assert.deepEqual(forwarded, ["#abcdef"]);
    assert.equal(scheduler.pending, 0);
  });

  it("drops a waiting value so a later frame forwards nothing", () => {
    const scheduler = fakeScheduler();
    const forwarded: string[] = [];
    const coalescer = createFrameCoalescer((value: string) => {
      forwarded.push(value);
    }, scheduler);
    coalescer.push("#abcdef");
    coalescer.drop();
    scheduler.fire();
    assert.deepEqual(forwarded, []);
  });

  it("forwards nothing after dispose", () => {
    const scheduler = fakeScheduler();
    const forwarded: string[] = [];
    const coalescer = createFrameCoalescer((value: string) => {
      forwarded.push(value);
    }, scheduler);
    coalescer.push("#111111");
    coalescer.dispose();
    scheduler.fire();
    coalescer.push("#222222");
    coalescer.flush();
    assert.deepEqual(forwarded, []);
  });
});
