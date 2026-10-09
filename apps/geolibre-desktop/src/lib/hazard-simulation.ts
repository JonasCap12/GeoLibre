import type { HazardFix } from "./hazard-zones";

export const SIMULATION_FIX_INTERVAL_MS = 1_000;
export const SIMULATION_ACCURACY_M = 8;

export interface SimulatedPosition {
  lng: number;
  lat: number;
  accuracy?: number;
}

export interface SimulationScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HazardSimulationStream {
  /** Move the simulated receiver, emit immediately, and keep emitting fresh fixes. */
  move(position: SimulatedPosition): void;
  /** Stop fixes without manufacturing a stale one, so normal stale detection takes over. */
  loseSignal(): void;
  /** Stop and release the stream when simulation is disabled. */
  stop(): void;
}

const browserScheduler: SimulationScheduler = {
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Create a GPS-like simulation stream with injectable time and scheduling.
 * A new click after signal loss starts the stream again at the new position.
 */
export function createHazardSimulationStream(
  emit: (fix: HazardFix) => void,
  now: () => number = Date.now,
  scheduler: SimulationScheduler = browserScheduler,
  intervalMs = SIMULATION_FIX_INTERVAL_MS,
): HazardSimulationStream {
  let position: Required<SimulatedPosition> | null = null;
  let interval: unknown;

  const emitCurrent = () => {
    if (!position) return;
    emit({ ...position, timestamp: now() });
  };
  const stopTimer = () => {
    if (interval === undefined) return;
    scheduler.clearInterval(interval);
    interval = undefined;
  };
  const startTimer = () => {
    if (interval !== undefined) return;
    interval = scheduler.setInterval(emitCurrent, intervalMs);
  };

  return {
    move(next) {
      position = {
        lng: next.lng,
        lat: next.lat,
        accuracy: next.accuracy ?? SIMULATION_ACCURACY_M,
      };
      emitCurrent();
      startTimer();
    },
    loseSignal() {
      position = null;
      stopTimer();
    },
    stop() {
      position = null;
      stopTimer();
    },
  };
}
