import {
  sourceRank,
  type Fact,
  type FactSource,
  type LivingRoomState,
  type Observation,
  type WorldEvent,
} from "./state.js";

/**
 * The Living Room World Model.
 *
 * A flat `path -> Fact` store with a nested read view. Flat because the paths a
 * living room produces are not knowable at compile time (`devices.ps5.power`
 * exists only once there is a PS5), and nested only where something has to be
 * shown or serialized.
 *
 * The three behaviours that make it worth having over a plain object:
 *
 *  - **Unknown is answerable.** `known(path)` distinguishes "not set", "too
 *    uncertain" and "too old" from a value, so a planner can decide to *look*
 *    rather than guess.
 *  - **Conflicts resolve by evidence, not by arrival order.** A user statement
 *    beats a tool read beats an inference; equal sources fall back to newest.
 *    A rejected observation is still recorded, because an adapter that keeps
 *    losing these arguments is an adapter that is lying.
 *  - **Age costs confidence.** Past its TTL a fact stays as a prior with decayed
 *    confidence instead of vanishing — good enough to plan with, not good
 *    enough to verify with.
 */

const DEFAULT_CONFIDENCE: Record<FactSource, number> = {
  user: 1,
  tool: 1,
  probe: 1,
  perception: 0.8,
  inferred: 0.7,
  assumed: 0.5,
};

export interface WorldModelOptions {
  /** Below this, `known()` says no. Default 0.4. */
  confidenceFloor?: number;
  /** How many change events to retain. Default 100. */
  historyLimit?: number;
  /** Injectable clock, so tests are not at the mercy of wall time. */
  now?: () => number;
}

export interface KnownOptions {
  /** Require at least this confidence (after decay). */
  minConfidence?: number;
  /** Reject a fact older than this, whatever its TTL says. */
  maxAgeMs?: number;
}

export class WorldModel {
  private facts = new Map<string, Fact>();
  private events: WorldEvent[] = [];
  private readonly floor: number;
  private readonly historyLimit: number;
  private readonly now: () => number;

  constructor(opts: WorldModelOptions = {}) {
    this.floor = opts.confidenceFloor ?? 0.4;
    this.historyLimit = opts.historyLimit ?? 100;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record a claim. Returns whether it changed what we believe — a rejected
   * observation is not an error, it is the store preferring better evidence.
   */
  observe<T>(obs: Observation<T>): boolean {
    const at = obs.observedAt ?? this.now();
    const incoming: Fact<T> = {
      value: obs.value,
      confidence: obs.confidence ?? DEFAULT_CONFIDENCE[obs.source],
      source: obs.source,
      observedAt: at,
      ...(obs.ttlMs !== undefined ? { ttlMs: obs.ttlMs } : {}),
    };

    const held = this.facts.get(obs.path);
    if (held) {
      const wins = obs.override ? at >= held.observedAt : this.supersedes(incoming, held);
      if (!wins) {
        // Only worth logging when the two actually disagree; re-reading the same
        // value with weaker evidence is normal and says nothing.
        if (!Object.is(held.value, incoming.value)) {
          this.log({ path: obs.path, from: held.value, to: incoming.value, source: obs.source, at, rejected: true });
        }
        return false;
      }
    }

    this.facts.set(obs.path, incoming as Fact);
    if (!held || !Object.is(held.value, incoming.value)) {
      this.log({ path: obs.path, from: held?.value, to: incoming.value, source: obs.source, at });
    }
    return true;
  }

  /** Record several claims from one source at one instant. */
  observeAll(observations: Observation[]): void {
    const at = this.now();
    for (const obs of observations) this.observe({ observedAt: at, ...obs });
  }

  /** The fact at a path, with confidence already decayed for age. */
  get<T = unknown>(path: string): Fact<T> | undefined {
    const fact = this.facts.get(path) as Fact<T> | undefined;
    if (!fact) return undefined;
    return { ...fact, confidence: this.decayed(fact) };
  }

  /** The value, or `undefined` for "we do not know" — which is a real answer. */
  value<T = unknown>(path: string, opts: KnownOptions = {}): T | undefined {
    return this.known(path, opts) ? (this.facts.get(path)!.value as T) : undefined;
  }

  /** Do we know this well enough to act on it without looking again? */
  known(path: string, opts: KnownOptions = {}): boolean {
    const fact = this.facts.get(path);
    if (!fact) return false;
    if (opts.maxAgeMs !== undefined && this.now() - fact.observedAt > opts.maxAgeMs) return false;
    return this.decayed(fact) >= (opts.minConfidence ?? this.floor);
  }

  /** Is this fact past its TTL? Stale facts still plan; they never verify. */
  stale(path: string): boolean {
    const fact = this.facts.get(path);
    if (!fact?.ttlMs) return false;
    return this.now() - fact.observedAt > fact.ttlMs;
  }

  /** Forget a path entirely — for "I no longer have any idea", not for "false". */
  forget(path: string): boolean {
    return this.facts.delete(path);
  }

  /** Every path currently held, optionally under a prefix. */
  paths(prefix?: string): string[] {
    const all = [...this.facts.keys()];
    return prefix ? all.filter((p) => p === prefix || p.startsWith(`${prefix}.`)) : all;
  }

  /** The change log, newest last. */
  get history(): readonly WorldEvent[] {
    return this.events;
  }

  /** Nested view, facts intact — for `?diag`, persistence and tests. */
  snapshot(): LivingRoomState {
    const out: LivingRoomState = {};
    for (const [path, fact] of this.facts) {
      const parts = path.split(".");
      const leaf = parts.pop()!;
      let node = out as Record<string, unknown>;
      for (const part of parts) {
        const next = node[part];
        if (typeof next !== "object" || next === null) node[part] = {};
        node = node[part] as Record<string, unknown>;
      }
      node[leaf] = { ...fact, confidence: this.decayed(fact) };
    }
    return out;
  }

  /** Restore from a `dump()`. Unknown paths are simply added. */
  restore(dump: Record<string, Fact>): void {
    for (const [path, fact] of Object.entries(dump)) this.facts.set(path, fact);
  }

  /** Flat, serializable form. */
  dump(): Record<string, Fact> {
    return Object.fromEntries(this.facts);
  }

  /**
   * A compact, human-readable block of what we currently know, for the LLM's
   * system prompt.
   *
   * Only facts we actually know go in: padding the prompt with "volume: unknown"
   * teaches the model to distrust the whole block. Stale facts are marked rather
   * than dropped, because "was 35 a while ago" is useful and "35" would be a lie.
   */
  summarize(opts: { maxChars?: number; minConfidence?: number } = {}): string {
    const maxChars = opts.maxChars ?? 600;
    const lines: string[] = [];
    for (const path of [...this.facts.keys()].sort()) {
      if (!this.known(path, opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {})) continue;
      const fact = this.facts.get(path)!;
      const mark = this.stale(path) ? " (stale)" : "";
      lines.push(`${path}: ${format(fact.value)}${mark}`);
    }
    let out = "";
    for (const line of lines) {
      if (out.length + line.length + 1 > maxChars) break;
      out += (out ? "\n" : "") + line;
    }
    return out;
  }

  /** Paths whose value differs between two snapshots of `dump()`. */
  static diff(before: Record<string, Fact>, after: Record<string, Fact>): string[] {
    const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...paths].filter((p) => !Object.is(before[p]?.value, after[p]?.value)).sort();
  }

  /** Stronger evidence wins; equal strength falls back to the newer observation. */
  private supersedes(incoming: Fact, held: Fact): boolean {
    const a = sourceRank(incoming.source);
    const b = sourceRank(held.source);
    if (a !== b) return a > b;
    if (incoming.observedAt !== held.observedAt) return incoming.observedAt >= held.observedAt;
    return incoming.confidence >= this.decayed(held);
  }

  /**
   * Confidence after age.
   *
   * Linear from full confidence at the TTL down to a floor of 20% of it at three
   * TTLs. The exact curve is not the point — the point is that a fact nobody has
   * checked in an hour must not be allowed to argue with equal force against one
   * read a second ago.
   */
  private decayed(fact: Fact): number {
    if (!fact.ttlMs) return fact.confidence;
    const age = this.now() - fact.observedAt;
    if (age <= fact.ttlMs) return fact.confidence;
    const over = Math.min((age - fact.ttlMs) / (fact.ttlMs * 2), 1);
    return fact.confidence * (1 - 0.8 * over);
  }

  private log(event: WorldEvent): void {
    this.events.push(event);
    if (this.events.length > this.historyLimit) this.events.shift();
  }
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
