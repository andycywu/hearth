import type { Plan, PlanSource } from "./types.js";

/**
 * How often the agent had to ask a model, and how often it did not.
 *
 * This is instrumentation for a *business* question, which is why it exists at
 * all. The deterministic planner closes any goal the Capability Graph can
 * measure for **zero tokens, zero latency and no network**; a model — local or
 * remote — costs a fraction of a cent per turn. Against smart-TV platform
 * revenue of a few dollars per set per year, the ratio between those two decides
 * whether goal mode is a product or a demo, and until now nobody had counted it.
 *
 * Deliberately local: counters in memory, read by `?diag` and by the device
 * report, and never sent anywhere. This repo's contribution rules refuse
 * telemetry that phones home, and a cost metric is not an exception.
 */

export interface PlanningSnapshot {
  /** Plans the Capability Graph closed on its own. Free. */
  deterministic: number;
  /** Plans a local model produced. */
  model: number;
  /** Plans a remote decision engine produced. */
  remote: number;
  /** A remote engine was asked, could not answer, and the local planner did. */
  localFallback: number;
  /** Plans with no recorded source — built by hand, or by an older planner. */
  unattributed: number;
  /** Conversational turns, which always cost a model call. */
  chatTurns: number;
  /** Plans that produced no steps at all. A subset of the counts above. */
  emptyPlans: number;
  /** Plans produced without a model call, over all plans. `undefined` if none. */
  zeroTokenRatio?: number;
  /** Model-backed *planning* calls: `model + remote`. Excludes chat. */
  modelBackedPlans: number;
  totalPlans: number;
  /** Observed cost, when a planner reported one (ModelPilot does). USD. */
  observedCost: number;
}

/**
 * What this would cost per television per year, at a stated rate of use.
 *
 * A ratio is not a decision. "82% of planning is free" does not tell anyone
 * whether to ship it; "$0.40 per set per year against an ARPU of $6" does. The
 * arithmetic is trivial and that is the point — the number nobody had was the
 * *input*, and the meter now has it.
 */
export interface CostProjection {
  /** Model-backed calls per turn, from what was actually measured. */
  modelBackedShare: number;
  /** USD per model-backed call. Measured if available, else the caller's guess. */
  costPerCall: number;
  /** Where `costPerCall` came from — a measurement or an assumption. */
  costBasis: "measured" | "assumed";
  perDay: number;
  perYear: number;
  /** Restates the assumption, so a number is never quoted without it. */
  assumption: string;
}

export class PlanningMeter {
  private counts: Record<PlanSource | "unattributed", number> = {
    deterministic: 0, model: 0, remote: 0, "local-fallback": 0, unattributed: 0,
  };
  private chat = 0;
  private empty = 0;
  private cost = 0;

  /** Record a plan as it is produced, whoever produced it. */
  record(plan: Plan): void {
    this.counts[plan.source ?? "unattributed"]++;
    if (!plan.steps.length) this.empty++;
  }

  /** Record a conversational turn — always a model call, never free. */
  recordChatTurn(): void {
    this.chat++;
  }

  snapshot(): PlanningSnapshot {
    const { deterministic, model, remote, unattributed } = this.counts;
    const localFallback = this.counts["local-fallback"];
    const totalPlans = deterministic + model + remote + localFallback + unattributed;
    const modelBackedPlans = model + remote;
    // `local-fallback` counts as zero-token: the model was asked and answered
    // nothing usable, so no tokens were spent on the plan that ran. The *call*
    // still cost latency, which is why `remote` and `localFallback` are separate
    // numbers rather than one.
    const free = deterministic + localFallback;

    return {
      deterministic, model, remote, localFallback, unattributed,
      chatTurns: this.chat,
      emptyPlans: this.empty,
      ...(totalPlans ? { zeroTokenRatio: free / totalPlans } : {}),
      modelBackedPlans,
      totalPlans,
      observedCost: this.cost,
    };
  }

  /** Add a cost a planner actually reported, in USD. */
  recordCost(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.cost += usd;
  }

  /**
   * Project the annual cost per device from what has been measured so far.
   *
   * `turnsPerDay` is the household behaviour nobody here knows — it is an
   * assumption and is reported as one. Everything else comes from counters.
   */
  project(opts: { turnsPerDay: number; costPerCall?: number }): CostProjection | undefined {
    const s = this.snapshot();
    const turns = s.totalPlans + s.chatTurns;
    if (!turns) return undefined;

    const modelBacked = s.modelBackedPlans + s.chatTurns;
    const share = modelBacked / turns;
    const measured = s.observedCost > 0 && s.modelBackedPlans > 0
      ? s.observedCost / s.modelBackedPlans
      : undefined;
    const costPerCall = measured ?? opts.costPerCall ?? 0.001;
    const perDay = share * opts.turnsPerDay * costPerCall;

    return {
      modelBackedShare: share,
      costPerCall,
      costBasis: measured === undefined ? "assumed" : "measured",
      perDay,
      perYear: perDay * 365,
      assumption: `${opts.turnsPerDay} turns/day/device, $${costPerCall.toFixed(5)} per model-backed call `
        + `(${measured === undefined ? "assumed" : "measured"}), ${Math.round(share * 100)}% of turns model-backed`,
    };
  }

  reset(): void {
    this.counts = { deterministic: 0, model: 0, remote: 0, "local-fallback": 0, unattributed: 0 };
    this.chat = 0;
    this.empty = 0;
    this.cost = 0;
  }

  /** One line for `?diag`, a boot log or a bench run. */
  describe(): string {
    const s = this.snapshot();
    if (!s.totalPlans && !s.chatTurns) return "planning: nothing planned yet";
    const ratio = s.zeroTokenRatio === undefined ? "n/a" : `${Math.round(s.zeroTokenRatio * 100)}%`;
    return [
      `planning: ${s.totalPlans} plan(s)`,
      `zero-token ${ratio}`,
      `deterministic ${s.deterministic}`,
      `model ${s.model}`,
      `remote ${s.remote}`,
      `fallback ${s.localFallback}`,
      `chat turns ${s.chatTurns}`,
    ].join(" · ");
  }
}
