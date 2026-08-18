import type { Capability } from "../capabilities/types.js";
import type { PolicyEngine } from "../policy/policy.js";
import type { WorldModel } from "../world/model.js";
import { observationsFrom, type PerceptionEvent, type PerceptionSource, type SensorKind } from "./events.js";

/**
 * The gate between a sensor and everything else.
 *
 * A camera in a living room is not a feature to be switched on by whoever gets to
 * the code first. Three properties are enforced here, at the boundary, rather
 * than asked of each source — because a source is exactly the thing you cannot
 * assume is well behaved, and because "the vendor's CV library promised" is not a
 * privacy model:
 *
 *  1. **Nothing starts without a grant.** `start()` asks policy, and policy's
 *     `ask` needs a human. No grant, no sensor — and the source's `start()` is
 *     never even called, so a library that opens the camera in its constructor is
 *     the only remaining way to get this wrong, which is a review item, not a
 *     silent one.
 *  2. **Raw data does not cross.** Frames, buffers, sample arrays and anything
 *     that is not a small primitive are stripped from every event before it goes
 *     anywhere. A misbehaving source cannot smuggle a picture into the world
 *     model, the prompt or a log, because the picture is gone by the time
 *     anything downstream sees the event.
 *  3. **Revocation is immediate.** Revoking drops the grant *first*, so an event
 *     already in flight is discarded even if `stop()` is slow, asynchronous, or
 *     quietly ignored by the source.
 *
 * See docs/policy-and-safety.md.
 */

export interface PerceptionGrant {
  sourceId: string;
  sensors: SensorKind[];
  grantedAt: number;
  /** Grants may be time-boxed; an expired one stops the source on next event. */
  expiresAt?: number;
}

export interface PerceptionManagerOptions {
  world: WorldModel;
  policy: PolicyEngine;
  /** Asked when policy says `ask`. Without one, a sensor never starts. */
  confirm?: (req: { source: PerceptionSource; prompt: string }) => boolean | Promise<boolean>;
  /** Every event that survived the gate. Raw data is already stripped. */
  onEvent?: (event: PerceptionEvent, sourceId: string) => void;
  /** Grant taken or dropped, for a host that shows a sensor indicator. */
  onGrantChange?: (grant: PerceptionGrant | undefined, sourceId: string) => void;
  now?: () => number;
}

export type StartResult =
  | { started: true; grant: PerceptionGrant }
  | { started: false; reason: string };

/**
 * Keys a source must not be able to put in an event, whatever it calls them.
 *
 * Two families. The first is raw capture — a frame, a buffer, a data URL. The
 * second is *identity and content*: a transcript, a face embedding, someone's
 * name. The second matters more and is easier to miss, because it arrives as
 * innocent-looking short strings rather than megabytes of pixels, and a
 * transcript of what a family said in their living room is the single worst thing
 * this pipeline could carry into a prompt.
 */
const RAW_KEYS =
  /frame|image|photo|snapshot|pixels?|buffer|bytes|samples?|audio|waveform|dataurl|base64|blob|stream|raw/i;
const IDENTITY_KEYS =
  /transcript|caption|utterance|speech|voice|face|embedding|descriptor|identity|name|person|user|profile|gender|age|emotion/i;

export class PerceptionManager {
  private sources = new Map<string, PerceptionSource>();
  private grants = new Map<string, PerceptionGrant>();
  private running = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly opts: PerceptionManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Make a source available. Registering does not start it or grant anything. */
  register(source: PerceptionSource): void {
    this.sources.set(source.id, source);
  }

  list(): PerceptionSource[] {
    return [...this.sources.values()];
  }

  /** Which sources are live right now — what a sensor indicator should show. */
  get active(): string[] {
    return [...this.running];
  }

  grantFor(sourceId: string): PerceptionGrant | undefined {
    const grant = this.grants.get(sourceId);
    if (!grant) return undefined;
    return grant.expiresAt !== undefined && this.now() > grant.expiresAt ? undefined : grant;
  }

  /**
   * Ask, then start. Returns why not, rather than throwing: a declined camera is
   * an ordinary answer and the caller usually wants to say so, not handle an
   * exception.
   */
  async start(sourceId: string, opts: { forMs?: number } = {}): Promise<StartResult> {
    const source = this.sources.get(sourceId);
    if (!source) return { started: false, reason: `no perception source called ${sourceId}` };
    if (this.running.has(sourceId)) {
      const grant = this.grantFor(sourceId);
      return grant ? { started: true, grant } : { started: false, reason: "grant expired" };
    }

    const capability = capabilityForPerception(source);
    const decision = this.opts.policy.check({ capability, args: {}, actor: "user", world: this.opts.world });
    if (decision.effect === "deny") return { started: false, reason: decision.reason };
    if (decision.effect === "ask") {
      if (!this.opts.confirm) {
        return { started: false, reason: `${source.label} needs consent, and nothing can ask for it` };
      }
      const approved = await this.opts.confirm({ source, prompt: decision.prompt });
      if (!approved) return { started: false, reason: `${source.label} was not allowed` };
    }

    const grant: PerceptionGrant = {
      sourceId,
      sensors: [...source.sensors],
      grantedAt: this.now(),
      ...(opts.forMs !== undefined ? { expiresAt: this.now() + opts.forMs } : {}),
    };
    this.grants.set(sourceId, grant);
    this.running.add(sourceId);
    this.opts.onGrantChange?.(grant, sourceId);

    try {
      await source.start((event) => this.ingest(sourceId, event));
    } catch (err) {
      await this.revoke(sourceId);
      return { started: false, reason: (err as Error).message };
    }
    return { started: true, grant };
  }

  /**
   * Drop the grant, then ask the source to stop.
   *
   * That order is the point. If `stop()` is slow, asynchronous, or a no-op in
   * some vendor library, the sensor may keep firing — and every one of those
   * events is now discarded, because the check is on our side of the boundary.
   */
  async revoke(sourceId: string): Promise<void> {
    this.grants.delete(sourceId);
    this.running.delete(sourceId);
    this.opts.onGrantChange?.(undefined, sourceId);
    try {
      await this.sources.get(sourceId)?.stop();
    } catch {
      /* a source that cannot stop cleanly is still revoked */
    }
  }

  /** Revoke everything — for "turn off all sensors" and for teardown. */
  async revokeAll(): Promise<void> {
    // Deduped: a running source is also a granted one, and revoking it twice
    // would tell a host's sensor indicator to switch off twice.
    for (const id of new Set([...this.running, ...this.grants.keys()])) await this.revoke(id);
  }

  /**
   * One event, from a source that may or may not still be allowed to send it.
   *
   * Returns how many world facts changed, which is 0 for anything dropped.
   */
  private ingest(sourceId: string, event: PerceptionEvent): number {
    if (!this.grantFor(sourceId)) {
      // Either never granted, revoked, or expired. Expiry is enforced on arrival
      // rather than by a timer, so a source that goes quiet costs nothing.
      if (this.running.has(sourceId)) void this.revoke(sourceId);
      return 0;
    }
    const clean = sanitize(event);
    let changed = 0;
    for (const obs of observationsFrom(clean)) {
      if (this.opts.world.observe(obs)) changed++;
    }
    this.opts.onEvent?.(clean, sourceId);
    return changed;
  }
}

/**
 * A perception source as a capability, so policy decides about it the same way it
 * decides about everything else.
 *
 * `medium` at minimum by the risk table, and the built-in `perception.consent`
 * rule asks regardless — which is why this does not try to be clever about the
 * level.
 */
export function capabilityForPerception(source: PerceptionSource): Capability {
  return {
    id: `perception.${source.id}`,
    name: source.label,
    description: `Sense the room using: ${source.sensors.join(", ")}.`,
    device: "tv",
    domain: "perception",
    parameters: {},
    riskLevel: "medium",
    provider: `perception:${source.id}`,
    confidence: 1,
    status: "available",
  };
}

/**
 * Strip everything that is not a small derived value.
 *
 * Allowed through: numbers, booleans, and strings of 32 characters or fewer.
 * Everything else — a buffer, a typed array, a data URL, a nested object, an
 * array of samples — is dropped, along with anything whose *key* reads like raw
 * capture or personal identity even when its value looks harmless. Both checks,
 * because a source can hide a frame under an innocent name and can also put a
 * transcript under an obvious one.
 */
export function sanitize<V extends Record<string, unknown>>(event: PerceptionEvent<V>): PerceptionEvent {
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(event.value ?? {})) {
    if (RAW_KEYS.test(key) || IDENTITY_KEYS.test(key)) continue;
    if (typeof raw === "number" || typeof raw === "boolean") value[key] = raw;
    // Every string a perception event legitimately carries is a short enum —
    // "low", "high", "dim", a device id. Anything longer is a data URL, an
    // encoded frame or something somebody said, and none of those belong here.
    else if (typeof raw === "string" && raw.length <= 32) value[key] = raw;
  }
  return {
    type: event.type,
    value,
    confidence: clampConfidence(event.confidence),
    timestamp: event.timestamp,
    ...(event.source ? { source: String(event.source).slice(0, 32) } : {}),
  };
}

function clampConfidence(confidence: number): number {
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
}
