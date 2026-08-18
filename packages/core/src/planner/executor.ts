import type { Capability, StateEffect } from "../capabilities/types.js";
import type { CapabilityGraph } from "../capabilities/graph.js";
import type { PolicyEngine, Actor, PolicyAuditEntry } from "../policy/policy.js";
import type { ToolRegistry } from "../tools/registry.js";
import { classifyToolError } from "../tools/result.js";
import type { WorldModel } from "../world/model.js";
import { observeResult } from "../world/from-tools.js";
import { allTrue, evaluate } from "./predicates.js";
import { remainingGap } from "./planner.js";
import type { Action, Plan, PlanOutcome, PlanStep, StepOutcome, StepStatus } from "./types.js";

/**
 * Run a plan, and never assume it worked.
 *
 * `execute -> assume success` is the failure mode this class exists to remove.
 * Switching an input on a TV that ignored the command, and then confidently
 * telling the user it is done, is worse than failing: the world model is now
 * wrong, and every subsequent plan is built on top of that.
 *
 * So each step ends in one of three honest states — the read-back agreed
 * (`verified`), there is no way to check on this device (`unverified`), or the
 * read-back disagreed (`failed`). Collapsing the middle one into either of the
 * others is what makes an agent untrustworthy in both directions.
 */

export interface ConfirmRequest {
  capability: Capability;
  args: Record<string, unknown>;
  prompt: string;
}

export interface PlanExecutorOptions {
  graph: CapabilityGraph;
  world: WorldModel;
  tools: ToolRegistry;
  policy?: PolicyEngine;
  /** Asked when policy says `ask`. Without one, `ask` is treated as a denial. */
  confirm?: (req: ConfirmRequest) => boolean | Promise<boolean>;
  actor?: Actor;
  onStep?: (outcome: StepOutcome) => void;
  /** Every policy decision, for the audit trail. */
  onPolicy?: (entry: PolicyAuditEntry) => void;
  now?: () => number;
}

export class PlanExecutor {
  constructor(private readonly opts: PlanExecutorOptions) {}

  async run(plan: Plan, signal?: AbortSignal): Promise<PlanOutcome> {
    const outcomes: StepOutcome[] = [];
    for (const step of plan.steps) {
      if (signal?.aborted) break;
      const outcome = await this.runStep(step, plan.id);
      outcomes.push(outcome);
      this.opts.onStep?.(outcome);
      // A required step that failed invalidates everything built on top of it —
      // carrying on would run step 4's "enable game mode" against an input that
      // never switched. Optional steps never stop a plan.
      // A required step that could not run invalidates everything built on top
      // of it — carrying on would enable game mode on an input that never
      // switched.
      if (!step.optional && STOPS.has(outcome.status)) break;
    }

    const unmet = remainingGap(this.opts.world, plan.goal);
    const achieved = outcomes.every((o) => o.step.optional || OK.has(o.status)) && unmet.length === 0;
    return { plan, outcomes, achieved, unmet };
  }

  private async runStep(step: PlanStep, planId: string): Promise<StepOutcome> {
    const world = this.opts.world;

    // Already true? Then doing it again is noise at best — and at worst a second
    // "launch Netflix" on top of the one already playing.
    if (step.verification?.kind === "state" && evaluate(world, step.verification.predicate) === "true") {
      return { step, status: "satisfied", attempts: 0 };
    }
    if (step.expectedResult.length && satisfiedAlready(world, step.expectedResult)) {
      return { step, status: "satisfied", attempts: 0 };
    }

    if (!allTrue(world, step.preconditions)) {
      const blocking = step.preconditions.filter((p) => evaluate(world, p) === "false");
      if (blocking.length) {
        return {
          step,
          status: step.optional ? "skipped" : "failed",
          attempts: 0,
          detail: `precondition not met: ${blocking.map((p) => p.path).join(", ")}`,
        };
      }
      // Only unknowns left: act, and let verification settle it.
    }

    const routes: Action[] = [step.action, ...(step.fallbacks ?? [])];
    let attempts = 0;
    let lastDetail = "";
    // Set only when every route we tried said "this device cannot", so a plan
    // that ran out of *working* routes is still reported as a failure.
    let unsupported = false;

    for (const action of routes) {
      const capability = this.opts.graph.get(action.capabilityId);
      if (!capability) {
        lastDetail = `no capability ${action.capabilityId}`;
        continue;
      }

      const gate = await this.gate(capability, action.args, planId);
      if (gate) return { step, status: "denied", attempts, detail: gate, provider: capability.provider };

      const maxRetries = step.maxRetries ?? 1;
      for (let attempt = 0; attempt < maxRetries + 1; attempt++) {
        attempts++;
        const result = await this.invoke(capability, action.args);

        if (result.unsupported) {
          // Permanent on this device, so stop offering it — the same rule the
          // tool layer already applies, one level up where the planner can see
          // it and route to another provider.
          this.opts.graph.withdrawProvider(capability.id, capability.provider, result.detail);
          lastDetail = result.detail;
          unsupported = true;
          break; // next route; retrying an unsupported capability is pointless
        }
        if (!result.ok) {
          lastDetail = result.detail;
          unsupported = false;   // it tried, so this is a bad moment, not absence
          continue; // a bad moment, not a missing capability: retry
        }

        // Optimistic write, deliberately below the confidence of a read: it is
        // what we believe until verification agrees or corrects it.
        this.commit(step.expectedResult, "assumed", 0.6);

        const verdict = await this.verify(step, capability);
        if (verdict === "verified") {
          // Only for verification that did not *read*. A read-back has already put
          // the device's own answer in the world at full confidence, and
          // overwriting it with what we asked for would replace an observation
          // with a wish — on a quantised control those differ, and the difference
          // is the whole reason the read exists.
          if ((step.verification ?? capability.verification)?.kind !== "read_back") {
            this.commit(step.expectedResult, "tool", 1);
          }
          this.opts.graph.confirm(capability.id, capability.provider);
          return { step, status: "verified", attempts, provider: capability.provider };
        }
        if (verdict === "unverified") {
          return { step, status: "unverified", attempts, provider: capability.provider, detail: reasonFor(capability) };
        }
        lastDetail = "the device did not end up in the expected state";
      }
    }

    return {
      step,
      status: step.optional ? "skipped" : unsupported ? "unsupported" : "failed",
      attempts,
      ...(lastDetail ? { detail: lastDetail } : {}),
    };
  }

  /** Returns a denial reason, or undefined to proceed. */
  private async gate(
    capability: Capability,
    args: Record<string, unknown>,
    planId: string,
  ): Promise<string | undefined> {
    const policy = this.opts.policy;
    if (!policy) return undefined;
    const decision = policy.check({
      capability,
      args,
      actor: this.opts.actor ?? "user",
      world: this.opts.world,
      planId,
    });
    this.opts.onPolicy?.({
      at: this.opts.now?.() ?? Date.now(),
      capabilityId: capability.id,
      actor: this.opts.actor ?? "user",
      decision,
      planId,
    });
    if (decision.effect === "allow") return undefined;
    if (decision.effect === "deny") return decision.reason;
    // `ask` with nobody to ask is a denial, not an allowance. A host that wants
    // unattended operation says so by supplying a handler that answers yes.
    if (!this.opts.confirm) return `${capability.name} needs confirmation, and nothing can ask.`;
    const approved = await this.opts.confirm({ capability, args, prompt: decision.prompt });
    return approved ? undefined : "Declined.";
  }

  private async invoke(
    capability: Capability,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; unsupported: boolean; detail: string; data?: unknown }> {
    if (!capability.tool) {
      return { ok: false, unsupported: true, detail: `${capability.id} has no tool bound` };
    }
    try {
      const raw = await this.opts.tools.call(capability.tool, args);
      // Tools already answer in the `TvResult` envelope, so the taxonomy is not
      // re-derived here — `unsupported` means withdraw, `failed` means retry.
      if (raw && typeof raw === "object" && (raw as { ok?: unknown }).ok === false) {
        const err = raw as { error?: string; message?: string };
        return {
          ok: false,
          unsupported: err.error === "unsupported",
          detail: err.message ?? err.error ?? "failed",
        };
      }
      observeResult(this.opts.world, capability, raw);
      return { ok: true, unsupported: false, detail: "", data: raw };
    } catch (err) {
      const classified = classifyToolError(err);
      return classified.ok
        ? { ok: true, unsupported: false, detail: "" }
        : { ok: false, unsupported: classified.error === "unsupported", detail: classified.message };
    }
  }

  private async verify(step: PlanStep, capability: Capability): Promise<"verified" | "unverified" | "failed"> {
    const v = step.verification ?? capability.verification;
    if (!v || v.kind === "none") return "unverified";

    if (v.kind === "read_back") {
      const reader = this.opts.graph.get(v.capability);
      if (!reader?.tool) return "unverified";
      const read = await this.invoke(reader, {});
      if (!read.ok) return "unverified"; // could not look; do not claim failure
      return evaluate(this.opts.world, v.predicate) === "true" ? "verified" : "failed";
    }

    if (v.kind === "state") {
      // Our own optimistic write must not be allowed to verify itself. Only
      // evidence counts — a tool read, a probe, a sensor, or the user saying so —
      // otherwise every unverifiable action would report `verified` on the
      // strength of the assumption it just made.
      const backing = this.opts.world.get(v.predicate.path)?.source;
      if (backing === undefined || backing === "assumed" || backing === "inferred") return "unverified";
      const truth = evaluate(this.opts.world, v.predicate);
      return truth === "true" ? "verified" : truth === "unknown" ? "unverified" : "failed";
    }

    // Perception-backed verification needs a sensor and an event loop; until
    // there is one, saying "unverified" is the honest answer.
    return "unverified";
  }

  private commit(effects: StateEffect[], source: "assumed" | "tool", confidence: number): void {
    for (const effect of effects) {
      this.opts.world.observe({
        path: effect.path,
        value: effect.set,
        source: effect.source ?? source,
        confidence: effect.confidence ?? confidence,
        // We just did this: whatever the world held about this path is now
        // history, not a competing claim.
        override: true,
      });
    }
  }
}

const OK = new Set<StepStatus>(["satisfied", "verified", "unverified", "skipped"]);
/** Statuses that end a plan: nothing after them can be built on. */
const STOPS = new Set<StepStatus>(["failed", "unsupported", "denied"]);

function satisfiedAlready(world: WorldModel, effects: StateEffect[]): boolean {
  return effects.every((e) => world.known(e.path) && Object.is(world.value(e.path), e.set));
}

function reasonFor(capability: Capability): string {
  const v = capability.verification;
  return v?.kind === "none" ? v.because : "nothing on this device can confirm it";
}
