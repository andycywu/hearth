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
}

export class PlanningMeter {
  private counts: Record<PlanSource | "unattributed", number> = {
    deterministic: 0, model: 0, remote: 0, "local-fallback": 0, unattributed: 0,
  };
  private chat = 0;
  private empty = 0;

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
    };
  }

  reset(): void {
    this.counts = { deterministic: 0, model: 0, remote: 0, "local-fallback": 0, unattributed: 0 };
    this.chat = 0;
    this.empty = 0;
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
