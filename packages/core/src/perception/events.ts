import { W } from "../world/state.js";
import type { Observation } from "../world/state.js";
import type { WorldModel } from "../world/model.js";

/**
 * Sensing the room, as events rather than as data.
 *
 * P0 defines the interface and the reducer and nothing else: no CV model, no
 * camera, no audio analysis. That is the point — the shape has to exist before
 * anything produces it, so that when a camera does arrive it feeds the World
 * Model through a path that was designed rather than bolted on.
 *
 * The privacy rule is structural, not a guideline: raw frames and raw audio stop
 * at the perception source. Only derived events cross this boundary, so nothing
 * downstream — world model, prompt, logs, cloud — can leak what it never had.
 * See docs/policy-and-safety.md.
 */

export type PerceptionEventType =
  | "occupancy_changed"
  | "person_entered"
  | "person_left"
  | "child_detected"
  | "low_light"
  | "ambient_light_changed"
  | "speech_detected"
  | "high_noise"
  | "device_signal";

export interface PerceptionEvent<V = Record<string, unknown>> {
  type: PerceptionEventType;
  value: V;
  /** 0..1 — a perception source that cannot estimate this should not report. */
  confidence: number;
  /** ISO 8601. */
  timestamp: string;
  /** `vision` | `audio` | `cec` | `presence` — which sensor, not which vendor. */
  source?: string;
}

/** What a source physically reads. Consent is asked per sensor, not per source. */
export type SensorKind = "camera" | "microphone" | "presence" | "ambient";

export interface PerceptionSource {
  id: string;
  /** Shown to the user when consent is asked. Say what it senses, plainly. */
  label: string;
  /**
   * The sensors this source opens. A person deciding whether to allow something
   * needs to know a camera is involved; "occupancy" does not tell them that.
   */
  sensors: SensorKind[];
  /** Requires a policy grant before it may be started. Never auto-starts. */
  start(emit: (event: PerceptionEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * How long a perceived fact stays evidence. People move; a light level read
 * five minutes ago should not be allowed to argue with the camera.
 */
const TTL = {
  occupancy: 5 * 60_000,
  light: 10 * 60_000,
  noise: 2 * 60_000,
} as const;

/**
 * Turn one perception event into world observations.
 *
 * Returns them rather than applying them, so a caller can inspect, gate on
 * policy, or drop them — a perception source must not be able to write to the
 * world just by firing.
 */
export function observationsFrom(event: PerceptionEvent): Observation[] {
  const at = Date.parse(event.timestamp);
  const observedAt = Number.isNaN(at) ? undefined : at;
  const base = { source: "perception" as const, confidence: event.confidence, ...(observedAt !== undefined ? { observedAt } : {}) };
  const v = event.value as Record<string, unknown>;

  switch (event.type) {
    case "occupancy_changed":
      return typeof v.peopleCount === "number"
        ? [{ ...base, path: W.roomPeopleCount, value: v.peopleCount, ttlMs: TTL.occupancy }]
        : [];
    case "person_entered":
    case "person_left":
      // A count we can trust comes with the event; without one, presence still
      // says something ("someone is there"), and inventing a number would not.
      return typeof v.peopleCount === "number"
        ? [{ ...base, path: W.roomPeopleCount, value: v.peopleCount, ttlMs: TTL.occupancy }]
        : [{ ...base, path: "room.occupied", value: event.type === "person_entered", ttlMs: TTL.occupancy }];
    case "child_detected":
      return [{ ...base, path: "room.childPresent", value: true, ttlMs: TTL.occupancy }];
    case "low_light":
      return [{ ...base, path: W.roomAmbientLight, value: "low", ttlMs: TTL.light }];
    case "ambient_light_changed":
      return typeof v.level === "string"
        ? [{ ...base, path: W.roomAmbientLight, value: v.level, ttlMs: TTL.light }]
        : [];
    case "high_noise":
      return [{ ...base, path: "room.noise", value: "high", ttlMs: TTL.noise }];
    case "speech_detected":
      return [{ ...base, path: "room.speech", value: true, ttlMs: TTL.noise }];
    case "device_signal":
      return typeof v.deviceId === "string"
        ? [{ ...base, path: W.device(v.deviceId, "power"), value: v.power ?? "on" }]
        : [];
  }
}

/** Apply a perception event to the world. Returns how many facts it changed. */
export function applyPerception(world: WorldModel, event: PerceptionEvent): number {
  let changed = 0;
  for (const obs of observationsFrom(event)) {
    if (world.observe(obs)) changed++;
  }
  return changed;
}
