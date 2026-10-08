/**
 * Forwards the latest value at most once per scheduled frame.
 *
 * A native colour input emits a sample on every drag movement. Callers that
 * write each sample into a store would redo that work dozens of times a
 * second. This keeps only the newest sample and lets the caller flush it
 * early when the gesture ends.
 */
export interface FrameScheduler {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
}

export interface FrameCoalescer<T> {
  /** Remember `value` and schedule one forward if none is waiting. */
  push: (value: T) => void;
  /** Forward a waiting value now, once, and cancel its frame. */
  flush: () => void;
  /** Forget a waiting value without forwarding it. */
  drop: () => void;
  /** Ignore every later push, flush, and already-scheduled frame. */
  dispose: () => void;
}

export function createFrameCoalescer<T>(
  forward: (value: T) => void,
  scheduler: FrameScheduler,
): FrameCoalescer<T> {
  let disposed = false;
  let pending = false;
  let latest: T | undefined;
  let handle: number | null = null;

  const clearFrame = () => {
    if (handle === null) return;
    scheduler.cancel(handle);
    handle = null;
  };

  return {
    push(value) {
      if (disposed) return;
      latest = value;
      pending = true;
      if (handle !== null) return;
      handle = scheduler.request(() => {
        handle = null;
        if (disposed || !pending) return;
        pending = false;
        forward(latest as T);
      });
    },
    flush() {
      if (disposed || !pending) return;
      clearFrame();
      pending = false;
      forward(latest as T);
    },
    drop() {
      clearFrame();
      pending = false;
    },
    dispose() {
      disposed = true;
      clearFrame();
      pending = false;
    },
  };
}
