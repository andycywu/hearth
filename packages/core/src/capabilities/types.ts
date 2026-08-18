import type { ToolParameter } from "../tools/registry.js";
import type { FactSource } from "../world/state.js";

/**
 * What the agent can do here, described well enough to plan with.
 *
 * A `ToolSpec` tells the model what it may ask for. It says nothing about what
 * must be true first, what will change, what it costs if it goes wrong, or how
 * anyone would know it worked — which is exactly the set of questions a planner,
 * a policy engine and a verifier each need answered. That is the whole reason
 * this type exists next to `ToolSpec` rather than replacing it: one is the
 * model's menu, the other is the agent's model of its own reach.
 *
 * See docs/capability-graph.md.
 */

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type CapabilityDomain =
  | "power" | "display" | "audio" | "input" | "app"
  | "content" | "device" | "iot" | "perception" | "network" | "meta";

/** A condition over World Model paths. Absent operators mean "just exists". */
export interface StatePredicate {
  path: string;
  equals?: unknown;
  notEquals?: unknown;
  oneOf?: unknown[];
  gte?: number;
  lte?: number;
  /**
   * Tolerance for a numeric `equals`, because some controls are quantised.
   *
   * Android maps 0-100 onto `getStreamMaxVolume` steps — commonly 15, sometimes
   * 7 — so asking for 23 sets the nearest step and reads back 20. On a real
   * emulator that turned a working TV into "the device did not end up in the
   * expected state": the volume *had* gone down, by as much as the hardware can
   * express, and exact equality called it a failure.
   */
  within?: number;
  /** Treat an unknown value as satisfying this predicate (optimistic gates). */
  unknownOk?: boolean;
}

/** What a capability changes. `set` may be a `{param}` template. */
export interface StateEffect {
  path: string;
  set: unknown;
  /** Confidence to record the optimistic write at. Default 0.6. */
  confidence?: number;
  source?: FactSource;
}

export interface Constraint {
  description: string;
  parameter?: string;
  min?: number;
  max?: number;
  oneOf?: unknown[];
}

export type Verification =
  | { kind: "read_back"; capability: string; predicate: StatePredicate }
  | { kind: "state"; predicate: StatePredicate; timeoutMs?: number }
  | { kind: "perception"; event: string; timeoutMs?: number }
  /** Explicitly unverifiable. The reason is required and is shown in `?diag`. */
  | { kind: "none"; because: string };

export type CapabilityStatus =
  /** The device backs it, as far as we know. */
  | "available"
  /** It is claimed but nothing has proved it — the honest state for a write
   *  with no side-effect-free read, e.g. input switching on Tizen. */
  | "unverified"
  /** The device answered `unsupported`. Never offered again this session. */
  | "withdrawn";

export interface Capability {
  /** `<device>.<domain>.<verb>`, e.g. `tv.audio.set_volume`. */
  id: string;
  name: string;
  description: string;
  /** Device Graph node id. `tv` is the host TV. */
  device: string;
  domain: CapabilityDomain;
  parameters: Record<string, ToolParameter>;
  /** The registered tool that performs it. Absent for a purely declarative entry. */
  tool?: string;
  /**
   * How this capability's result maps into the world: result field -> world path.
   * A read capability is *defined* by this map — it is what turns `get_volume`
   * returning `{volume:35,muted:false}` into two facts, without a switch
   * statement somewhere that has to be kept in step with the tool list.
   */
  reads?: Record<string, string>;
  /**
   * Capability ids this one's read speaks for at boot.
   *
   * Set on a *read* capability, and it is what the boot probe uses: if this read
   * reports the API absent, everything listed here is withdrawn. It lives here
   * rather than in the probe because the inference is a property of the platform
   * object the capability wraps — Tizen's `audio()`, webOS's `luna()` — and the
   * exceptions are what matter: `tv.input.get_source` vouches only for itself,
   * because on Tizen the read works and the write is signing-gated forever.
   */
  vouchesFor?: string[];
  constraints?: Constraint[];
  preconditions?: StatePredicate[];
  sideEffects?: StateEffect[];
  riskLevel: RiskLevel;
  verification?: Verification;
  /** `adapter:aosp`, `cec`, `ir`, `skill:xumo` — who can actually do this. */
  provider: string;
  /** 0..1. How sure we are the device really has it. */
  confidence: number;
  status: CapabilityStatus;
}
