import type { PerceptionEvent, PerceptionSource } from "@hearthkit/core";

/**
 * Perception without a sensor.
 *
 * The point of this package is to make the whole path real — consent, gate,
 * sanitising, world update, decay — before any camera exists, because that is the
 * order in which those things should be built. A privacy boundary that arrives
 * after the sensor it is supposed to guard has already been shipped is a boundary
 * nobody trusts.
 *
 * Deliberately not a camera: nothing here opens a device, requests a permission
 * or touches `navigator.mediaDevices`. It reads a script and emits derived
 * events, which is exactly the shape a real occupancy model would present — and
 * it means the manager's tests exercise the same code path the real one will.
 */

export interface ScriptedSourceOptions {
  id?: string;
  label?: string;
  /** Events to emit, in order. `tick()` sends the next one. */
  script: PerceptionEvent[];
  /**
   * Emit automatically every N ms instead of waiting for `tick()`. Off by
   * default: a test wants control, and a demo wants a clock.
   */
  intervalMs?: number;
  /** Injectable clock, so an event's timestamp is not the wall clock in tests. */
  now?: () => number;
  /** Loop the script instead of stopping at the end. */
  repeat?: boolean;
}

export interface ScriptedSource extends PerceptionSource {
  /** Emit the next scripted event. Returns false when the script is exhausted. */
  tick(): boolean;
  /** How many events it has sent — including any the gate later dropped. */
  readonly sent: number;
}

/**
 * A source that behaves. Occupancy, ambient light, noise — derived values only.
 */
export function createScriptedSource(opts: ScriptedSourceOptions): ScriptedSource {
  let emit: ((event: PerceptionEvent) => void) | undefined;
  let index = 0;
  let sent = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const now = opts.now ?? (() => Date.now());

  const tick = (): boolean => {
    if (!emit) return false;
    if (index >= opts.script.length) {
      if (!opts.repeat) return false;
      index = 0;
    }
    const event = opts.script[index++]!;
    sent++;
    emit({ ...event, timestamp: event.timestamp || new Date(now()).toISOString() });
    return true;
  };

  return {
    id: opts.id ?? "mock-occupancy",
    label: opts.label ?? "Camera (occupancy only)",
    sensors: ["camera"],
    start: async (fn) => {
      emit = fn;
      if (opts.intervalMs) timer = setInterval(() => { void tick(); }, opts.intervalMs);
    },
    stop: async () => {
      emit = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    get sent() {
      return sent;
    },
  };
}

/** A short occupancy script: an empty room fills up and then empties. */
export function occupancyScript(now = () => Date.now()): PerceptionEvent[] {
  const at = (offset: number): string => new Date(now() + offset).toISOString();
  return [
    { type: "occupancy_changed", value: { peopleCount: 1 }, confidence: 0.9, timestamp: at(0), source: "vision" },
    { type: "occupancy_changed", value: { peopleCount: 3 }, confidence: 0.88, timestamp: at(1000), source: "vision" },
    { type: "low_light", value: {}, confidence: 0.8, timestamp: at(2000), source: "vision" },
    { type: "occupancy_changed", value: { peopleCount: 0 }, confidence: 0.95, timestamp: at(3000), source: "vision" },
  ];
}

/**
 * A source that misbehaves, for the tests that matter.
 *
 * It attaches a frame to every event and keeps emitting after `stop()`. Both are
 * realistic — the first is a vendor library being helpful, the second is one being
 * asynchronous — and both must be harmless. This lives here rather than in a test
 * file so the manager's guarantees can be exercised from anywhere, including by
 * whoever writes the first real source.
 */
export function createLeakySource(opts: { id?: string; now?: () => number } = {}): ScriptedSource {
  let emit: ((event: PerceptionEvent) => void) | undefined;
  let sent = 0;
  const now = opts.now ?? (() => Date.now());
  const frame = new Uint8Array(64).fill(7);

  const tick = (): boolean => {
    if (!emit) return false;
    sent++;
    emit({
      type: "occupancy_changed",
      value: {
        peopleCount: 2,
        frame,
        snapshotDataUrl: `data:image/png;base64,${"A".repeat(200)}`,
        transcript: "someone said something private in their living room",
        faces: [{ id: "person-1", embedding: [0.1, 0.2] }],
      } as unknown as Record<string, unknown>,
      confidence: 12,           // out of range, deliberately
      timestamp: new Date(now()).toISOString(),
      source: "vision",
    });
    return true;
  };

  return {
    id: opts.id ?? "leaky-camera",
    label: "Camera (badly behaved)",
    sensors: ["camera"],
    start: async (fn) => { emit = fn; },
    // Does not release the callback: it keeps firing after being told to stop.
    stop: async () => { /* deliberately ignored */ },
    tick,
    get sent() {
      return sent;
    },
  };
}
