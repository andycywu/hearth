/**
 * What the agent believes about the living room, and how sure it is.
 *
 * Every leaf is a `Fact`, never a bare value, because in a living room almost
 * everything is either unknown, stale, or believed for a reason that matters to
 * the next decision. `volume: 35` cannot express "35, read from the TV two
 * seconds ago" versus "35, because that is what we set an hour ago and nobody
 * checked" — and a planner that cannot tell those apart will confidently act on
 * the second one.
 *
 * See docs/world-model.md.
 */

/**
 * Where a fact came from, in precedence order — this ordering *is* the conflict
 * resolution rule, so it is declared once, here, rather than restated wherever
 * two observations disagree.
 */
export const FACT_SOURCES = ["user", "tool", "probe", "perception", "inferred", "assumed"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

/** Higher wins a conflict regardless of recency; ties fall back to newest. */
export function sourceRank(source: FactSource): number {
  return FACT_SOURCES.length - FACT_SOURCES.indexOf(source);
}

export interface Fact<T = unknown> {
  value: T;
  /** 0..1. A direct read is 1; an inference is less; an assumption less again. */
  confidence: number;
  source: FactSource;
  /** Epoch ms. */
  observedAt: number;
  /** After this long the fact is stale: still a prior, no longer evidence. */
  ttlMs?: number;
}

/** An incoming claim about the world, before it is reconciled with what we hold. */
export interface Observation<T = unknown> {
  path: string;
  value: T;
  source: FactSource;
  /** Defaults per source: user/tool/probe 1, perception 0.8, inferred 0.7, assumed 0.5. */
  confidence?: number;
  observedAt?: number;
  ttlMs?: number;
  /**
   * This claim is the consequence of an action we just took, so it supersedes
   * anything observed earlier whatever the source ranking says.
   *
   * Without it, the optimistic write after `set_volume(40)` loses to the
   * `get_volume` read from five seconds ago — precedence is meant to settle two
   * *competing* claims about the same moment, and "the TV was 30 before I
   * changed it" is not a competing claim, it is history.
   */
  override?: boolean;
}

/** One entry in the world's change log — what changed, and why we believed it. */
export interface WorldEvent {
  path: string;
  from: unknown;
  to: unknown;
  source: FactSource;
  at: number;
  /** Set when an observation was *rejected* in favour of what we already held. */
  rejected?: boolean;
}

/**
 * The living-room state, as a nested view over the flat fact store.
 *
 * Deliberately an open record rather than a closed interface: a device graph we
 * have not met yet contributes paths we did not name at compile time, and a
 * world model that can only hold what was foreseen is not a world model. The
 * well-known paths below are the stable subset everything else can rely on.
 */
export type LivingRoomState = Record<string, unknown>;

/**
 * The paths the core itself reads and writes. Adapters and skills may add more;
 * these are the ones with meaning to the planner, so they are named constants
 * rather than strings scattered through the code.
 */
export const W = {
  tvPower: "tv.power",
  tvInput: "tv.input",
  tvVolume: "tv.volume",
  tvMuted: "tv.muted",
  tvPictureMode: "tv.pictureMode",
  tvForegroundApp: "tv.foregroundApp",
  contentState: "content.state",
  contentTitle: "content.title",
  audioProfile: "audio.profile",
  currentActivity: "currentActivity",
  roomPeopleCount: "room.peopleCount",
  roomAmbientLight: "room.ambientLight",
  networkOnline: "network.online",
  /** Per-device state lives under `devices.<id>.*`. */
  device: (id: string, leaf: string): string => `devices.${id}.${leaf}`,
} as const;

export type Activity =
  | "idle" | "watching_streaming" | "watching_broadcast" | "gaming"
  | "listening_music" | "meeting" | "unknown";
