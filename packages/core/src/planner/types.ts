import type { Constraint, StateEffect, StatePredicate, Verification } from "../capabilities/types.js";
import type { CapabilityGraph } from "../capabilities/graph.js";
import type { DeviceGraph } from "../devices/graph.js";
import type { PolicyEngine } from "../policy/policy.js";
import type { WorldModel } from "../world/model.js";
import type { PlanningMeter } from "./meter.js";

/**
 * A goal, a plan, and what happened when we ran it.
 *
 * The whole point of these types is that `「我要打 PS5」` must not compile down to
 * `switch_input("hdmi2")`. It compiles to a *desired state*, which is then
 * compared against the *current state*, and the difference is what gets planned.
 * The HDMI port is looked up from the Device Graph at plan time, so the string
 * `hdmi2` appears nowhere in the core.
 *
 * See docs/agent-planner.md.
 */

export interface Goal {
  id: string;
  desiredState: StatePredicate[];
  /**
   * The user's own words, when no set of predicates captures what they asked
   * for.
   *
   * The deterministic planner ignores this — it can only close a gap it can
   * measure. The LLM planner reads it, which is what lets goal mode handle an
   * utterance nobody wrote a skill for. A goal with an intent and no
   * `desiredState` is honest about the trade: there is nothing to verify the
   * *goal* against afterwards, only each step.
   */
  intent?: string;
  /** Nice to have. A failure here never fails the plan. */
  optional?: StatePredicate[];
  constraints?: Constraint[];
  /** Filled from the utterance and the device graph: `{ device: "ps5" }`. */
  params?: Record<string, unknown>;
  /**
   * Capability ids in the order a skill wants them run, when the order matters
   * for reasons the preconditions do not capture — stopping playback before
   * switching input is politeness, not a dependency.
   */
  preferredOrder?: string[];
}

export interface Action {
  capabilityId: string;
  args: Record<string, unknown>;
}

export interface PlanStep {
  id: string;
  action: Action;
  preconditions: StatePredicate[];
  expectedResult: StateEffect[];
  verification?: Verification;
  /** Alternative routes, tried in order when the first fails verification. */
  fallbacks?: Action[];
  optional?: boolean;
  maxRetries?: number;
}

/**
 * Who produced a plan — the input to the planning-cost meter.
 *
 * On a television this is a margin question as much as an engineering one: a
 * `deterministic` plan costs no tokens, no latency and no network, and nobody
 * knew the ratio until it was counted.
 */
export type PlanSource =
  /** The Capability Graph closed the gap. Free. */
  | "deterministic"
  /** A local model planned it. */
  | "model"
  /** A remote decision engine planned it. */
  | "remote"
  /** A remote engine was asked and could not answer, so the local planner did. */
  | "local-fallback";

export interface Plan {
  id: string;
  goal: Goal;
  steps: PlanStep[];
  createdAt: number;
  /** Who planned it. Absent on a plan built by hand, e.g. in a test. */
  source?: PlanSource;
  /** Why these steps — shown in the UI and in logs, never fed back as truth. */
  rationale?: string;
  /** Goal predicates that no capability on this device can satisfy. */
  unreachable?: StatePredicate[];
  /**
   * Steps that were proposed and thrown out before anything ran.
   *
   * Kept rather than silently dropped: a plan that quietly lost half its steps
   * looks like a plan that succeeded, and when the proposer is a model this is
   * the only place the reason survives.
   */
  rejections?: PlanRejection[];
}

export interface PlanRejection {
  /** What was asked for, as proposed — capability id may not even exist. */
  capabilityId: string;
  args?: Record<string, unknown>;
  reason: string;
}

export type StepStatus =
  | "satisfied"      // already true; nothing to do
  | "verified"       // ran, and the read-back agreed
  | "unverified"     // ran, and nothing on this device can check it
  /**
   * This device cannot do it at all — the same distinction the tool layer draws
   * between `unsupported` and `failed`, one level up. "This TV can't switch
   * inputs" and "it tried and it didn't take" need different words from the
   * agent, and collapsing them sends someone to debug a TV that is working.
   */
  | "unsupported"
  | "failed"
  | "skipped"        // optional, and not possible here
  | "denied";        // policy said no

export interface StepOutcome {
  step: PlanStep;
  status: StepStatus;
  /** Which provider actually performed it, once fallbacks are involved. */
  provider?: string;
  attempts: number;
  detail?: string;
}

export interface PlanOutcome {
  plan: Plan;
  outcomes: StepOutcome[];
  /** True when every non-optional step ended `satisfied`, `verified` or `unverified`. */
  achieved: boolean;
  /** Goal predicates still false after execution. */
  unmet: StatePredicate[];
  /**
   * Why there was nothing to run: the skill could not express this as a goal
   * here (no such device, no idea how loud it is). Distinct from a plan that ran
   * and failed, and the user hears the difference.
   */
  blocked?: string;
}

export interface Planner {
  plan(goal: Goal): Promise<Plan>;
}

/**
 * What a planner needs from the agent that owns it.
 *
 * Handed to a `PlannerFactory` so a planner can reason over the *authoritative*
 * capability graph — the one the boot probe withdraws from — rather than a second
 * copy built beside it. Two graphs is a bug waiting to happen: the planner would
 * keep proposing a capability the agent had already given up on.
 */
export interface PlannerContext {
  capabilities: CapabilityGraph;
  world: WorldModel;
  devices: DeviceGraph;
  policy: PolicyEngine;
  /**
   * Where a planner reports what a call cost, if it knows.
   *
   * Handed over rather than looked up so a planner never has to reach back into
   * the agent — it receives everything it may touch, which is also the list of
   * everything it may touch.
   */
  meter: PlanningMeter;
}

export type PlannerFactory = (ctx: PlannerContext) => Planner;
