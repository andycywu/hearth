import {
  buildStep, callable, GoalPlanner, validateArgs,
  type Capability, type CapabilityGraph, type DeviceGraph, type Goal, type Plan,
  type PlanOutcome, type PlanRejection, type PlanStep, type Planner, type PolicyEngine,
  type StepStatus, type WorldModel,
} from "@hearthkit/core";
import type { ModelPilotAnswer, ModelPilotClient } from "./client.js";
import { ModelPilotError } from "./errors.js";
import type { ModelPilotMode } from "./config.js";
import { parseActionPlan, type TvActionPlan } from "./action-plan.js";
import { buildCompletionRequest } from "./task-mapper.js";
import { createTelemetryLogger, type ModelPilotTelemetry, type TelemetrySink } from "./telemetry.js";

/**
 * ModelPilot as a `Planner`, in three modes — and the boundary that makes it
 * safe to try on a real television.
 *
 * What crosses to the cloud: a minimised room summary and a goal. What comes
 * back: *a plan*. Not an action, not a result, and certainly not a claim that
 * anything happened. Every step it proposes is rebuilt through `buildStep`, so
 * the preconditions, the expected effects, the verification and the fallback
 * providers all still come from this device's Capability Graph. A remote engine
 * cannot weaken a check it is not asked to write, cannot name a capability this
 * TV does not have, and has no way to report its own answer as done.
 *
 * The modes:
 *
 *  - **off** — never calls. The local planner answers, as before.
 *  - **shadow** (default) — calls, records the suggestion, the request id and
 *    the model that answered, compares it with the local plan, and **executes
 *    the local one**. Device behaviour is byte-identical to `off`; the only
 *    difference is a telemetry record and a network call. Nothing is reported
 *    to `/v1/feedback` either, because the answer was never run.
 *  - **enforce** — the returned plan is what runs, after local validation and
 *    with local policy still deciding whether each step may happen.
 *
 * Fallback, stated rather than implied: when ModelPilot is *unavailable*
 * (timeout, unreachable, 5xx, unauthorised, out of quota, not configured)
 * enforce mode falls back to the local planner and records why. When ModelPilot
 * is *reached* and answers something unusable — a plan that fails the schema, or
 * one naming a capability this device does not have — that is not an
 * availability problem and there is no quiet fallback: the plan comes back empty
 * with the reason attached, which sends the agent to recovery or to the user.
 * Policy is never bypassed either way, because policy runs in the executor,
 * below both planners.
 *
 * **What is deliberately not a gate**: `modelpilot.evaluation_status`. It is the
 * service's Cost-Per-Successful-Task bookkeeping, it reads `unverified` on every
 * fresh completion until a verifier posts to `/v1/feedback`, and this planner
 * used to treat it as "the answer is unusable" — which made enforce mode refuse
 * every answer it ever received. Usability is `parseActionPlan`'s call; whether
 * the television did it is the local read-back's.
 *
 * **And what closes the loop**: `report(outcome)`. ModelPilot refuses to count a
 * completed call as a successful task until a verifier confirms the outcome, and
 * on a television this runtime is the only thing that can — it read the device
 * back. `verified` becomes `success: true`, `failed` becomes `success: false`,
 * and everything ambiguous is **not reported at all**, because an honest metric
 * is worth more to the service than a complete one. See `verdictFor`.
 */

export interface ModelPilotPlannerOptions {
  client?: ModelPilotClient;
  mode: ModelPilotMode;
  graph: CapabilityGraph;
  world: WorldModel;
  devices: DeviceGraph;
  policy?: PolicyEngine;
  /** Used by `off`, by `shadow`, and by enforce when ModelPilot is unavailable. */
  local?: Planner;
  telemetry?: TelemetrySink;
  /**
   * Where the engine's reported cost is accumulated.
   *
   * The agent's meter, normally. It turns "what share of planning needed a
   * model" into "what that share costs per device per year", which is the
   * question a product decision is actually made on.
   */
  meter?: { recordCost(usd: number): void };
  /**
   * Ceiling sent as `metadata.max_cost`, in USD, and echoed in telemetry.
   *
   * There is no latency ceiling to send: the service takes a latency *weight*,
   * not a deadline. The deadline is the client's `timeoutMs`.
   */
  maxTaskBudget?: number;
  /**
   * `local` (default) plans locally when ModelPilot is unavailable; `refuse`
   * returns an empty plan instead. A kiosk that must not act without the engine
   * chooses `refuse`.
   */
  onUnavailable?: "local" | "refuse";
  /**
   * In enforce mode, which goals ModelPilot decides.
   *
   * `all` (default) sends every goal, which is what "enforce" says on the tin.
   * `unmeasurable` keeps the deterministic planner in charge of anything the
   * Capability Graph can already close — "a bit quieter" costs no tokens, no
   * latency and no network — and asks ModelPilot only for the long tail. On a
   * television that choice is a margin decision as much as a behavioural one:
   * inference per turn against a platform ARPU of a few dollars a year.
   */
  enforceScope?: "all" | "unmeasurable";
  signal?: AbortSignal;
  now?: () => number;
  workflowId?: () => string;
}

/** What the last call produced, for a host that wants to show or store it. */
export interface ShadowRecord {
  workflowId: string;
  requestId?: string;
  selectedModel?: string;
  suggestion?: TvActionPlan;
  agreement: NonNullable<ModelPilotTelemetry["shadow_agreement"]>;
  localSteps: string[];
  remoteSteps: string[];
}

export interface ModelPilotPlanner extends Planner {
  /** Shadow-mode suggestions, newest last. Bounded; nothing is persisted. */
  readonly shadow: readonly ShadowRecord[];
  /**
   * Hand back what the television actually did with a plan this planner
   * produced, so it can reach `/v1/feedback`.
   *
   * Safe to call for every plan: one produced by any other planner, or in any
   * mode but enforce, is not in the ledger and is silently ignored. Never
   * rejects — a failed report is telemetry, not a device problem.
   *
   * Wire it once, at the host: `agent.events.on("plan:end", ({ outcome }) =>
   * planner.report(outcome))`.
   */
  report(outcome: PlanOutcome): Promise<void>;
}

const MAX_SHADOW_RECORDS = 20;

/**
 * How many answered plans to keep waiting for a verdict.
 *
 * Bounded because this runs on a television for months: a plan whose outcome
 * never arrives — the host never wired `report`, or the agent was torn down
 * mid-plan — must not accumulate. Twenty is far more than the one or two a
 * household has in flight, and the oldest is dropped rather than reported.
 */
const MAX_PENDING_VERDICTS = 20;

/** A plan ModelPilot produced, waiting to find out what the television did. */
interface PendingVerdict {
  workflowId: string;
  requestId: string;
  selectedModel?: string;
  taskType: string;
}

/**
 * What to tell ModelPilot about a plan of its own that has now run — or that
 * nothing may be said, which is a legitimate and frequent answer.
 *
 * The rules, and why each is what it is:
 *
 * | outcome | reported | because |
 * |---|---|---|
 * | every step `verified` / `satisfied` | `success: true` | the read-back agreed. This is the only unambiguous yes. |
 * | any step `failed` | `success: false` | it was attempted and the device did not end up in the expected state. The most valuable row in the table: an answer the router billed for, that did not work on real hardware. |
 * | the answer was unusable (no steps, a rejection) | `success: false` | a plan that fails the schema or names a capability this device lacks is the answer's fault, and it is the one thing CST would otherwise never hear about. |
 * | any step `unverified` | **nothing** | nothing on this device can confirm it. Reporting either way would launder a guess into somebody's primary metric. |
 * | any step `unsupported` | **nothing** | the capability existed in the graph and the adapter refused at run time. That is a fact about this television, not about the answer. |
 * | any step `denied` | **nothing** | local policy stopped it before it ran. Our rule, not their answer. |
 * | `ask_user` / `no_op` — no steps, no rejections | **nothing** | an engine deciding it needs a human is the system working, and there is nothing to verify. |
 *
 * The asymmetry is the point. ModelPilot's metric is only worth anything if the
 * denominator is honest, and a runtime that reported its uncertainty as a
 * success — or as a failure — would be quietly making it worthless.
 */
export function verdictFor(outcome: PlanOutcome): { success: boolean; comment: string } | undefined {
  const statuses = outcome.outcomes.map((o) => o.status);
  const has = (status: StepStatus): boolean => statuses.includes(status);

  if (!statuses.length) {
    // No steps ran. Either the answer was thrown out — which is a real failure
    // and the service should hear about it — or it asked for a human, which is
    // not a failure and has nothing to verify.
    const rejections = outcome.plan.rejections ?? [];
    if (!rejections.length) return undefined;
    return { success: false, comment: `plan rejected locally: ${rejections[0]?.reason ?? "unusable"}` };
  }

  if (has("failed")) {
    return { success: false, comment: `local verification failed: ${describeStatuses(statuses)}` };
  }
  if (has("unverified") || has("unsupported") || has("denied")) return undefined;

  // A plan whose every step was optional-and-not-possible ran nothing, so there
  // is nothing to have verified. `every` alone would have called that a success,
  // which is the same collapse the four step statuses exist to prevent.
  if (statuses.every((s) => s === "skipped")) return undefined;

  if (statuses.every((s) => s === "verified" || s === "satisfied" || s === "skipped")) {
    return { success: true, comment: `locally verified: ${describeStatuses(statuses)}` };
  }
  return undefined;
}

function describeStatuses(statuses: StepStatus[]): string {
  return statuses.join(",");
}

export function createModelPilotPlanner(opts: ModelPilotPlannerOptions): ModelPilotPlanner {
  const now = opts.now ?? (() => Date.now());
  const log = createTelemetryLogger(opts.telemetry);
  const shadow: ShadowRecord[] = [];
  // Only enforce-mode plans go in here. A shadow run executes the *local* plan,
  // so reporting its outcome as ModelPilot's would be telling the service a TV
  // did what its answer said when its answer was never run.
  const pending = new Map<string, PendingVerdict>();
  let counter = 0;
  const nextWorkflowId = opts.workflowId ?? (() => `wf-${now().toString(36)}-${++counter}`);
  const local = opts.local ?? new GoalPlanner({ graph: opts.graph, world: opts.world });

  async function plan(goal: Goal): Promise<Plan> {
    const workflowId = nextWorkflowId();
    const taskType = goal.id;

    if (opts.mode === "off" || !opts.client) {
      log({
        local_workflow_id: workflowId, mode: opts.mode, task_type: taskType, status: "skipped",
        fallback_reason: opts.client ? "mode is off" : "no ModelPilot client configured",
      });
      return withWorkflow(await local.plan(goal), workflowId);
    }

    // Deterministic first, when the host asked for that. Computed before the
    // call so a measurable goal costs nothing at all.
    if (opts.mode === "enforce" && (opts.enforceScope ?? "all") === "unmeasurable") {
      const localPlan = await local.plan(goal);
      if (localPlan.steps.length) {
        log({
          local_workflow_id: workflowId, mode: "enforce", task_type: taskType, status: "skipped",
          fallback_reason: "the deterministic planner closed this goal (enforceScope: unmeasurable)",
        });
        return withWorkflow(localPlan, workflowId);
      }
    }

    const request = buildCompletionRequest({
      goal, world: opts.world, devices: opts.devices, capabilities: opts.graph,
      ...(goal.intent ? { utterance: goal.intent } : {}),
      ...(opts.maxTaskBudget !== undefined ? { maxTaskBudget: opts.maxTaskBudget } : {}),
    });

    let result: ModelPilotAnswer;
    try {
      result = await opts.client.complete(
        request,
        opts.signal ? { signal: opts.signal } : {},
      );
    } catch (err) {
      const error = err instanceof ModelPilotError
        ? err
        : new ModelPilotError("server", String((err as Error)?.message ?? err));
      return handleUnavailable(goal, workflowId, taskType, error);
    }

    if (result.actualCost !== undefined) opts.meter?.recordCost(result.actualCost);

    // Reached and answered. From here the only question is whether the *answer*
    // is one this device can act on, which is the parser's call and nobody
    // else's.
    const parsed = parseActionPlan(result.output);
    if (!parsed.ok) {
      log({
        local_workflow_id: workflowId,
        ...ids(result),
        mode: opts.mode, task_type: taskType, status: "unusable_output",
        ...cost(result),
      });
      if (opts.mode === "shadow") return withWorkflow(await local.plan(goal), workflowId);
      return refused(goal, workflowId, result, `the plan did not validate: ${parsed.errors.join("; ")}`);
    }

    const { steps, rejections } = toSteps(parsed.plan, opts.graph);

    if (opts.mode === "shadow") {
      const localPlan = await local.plan(goal);
      const localSteps = localPlan.steps.map(describeStep);
      const remoteSteps = steps.map(describeStep);
      const agreement = compare(localSteps, remoteSteps);
      record(shadow, {
        workflowId, suggestion: parsed.plan, agreement, localSteps, remoteSteps,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        ...(result.selectedModel ? { selectedModel: result.selectedModel } : {}),
      });
      log({
        local_workflow_id: workflowId,
        ...ids(result),
        mode: "shadow", task_type: taskType, status: "ok",
        ...cost(result),
        shadow_agreement: agreement,
      });
      // The whole point of shadow: the device does exactly what it did before.
      return withWorkflow(localPlan, workflowId);
    }

    log({
      local_workflow_id: workflowId,
      ...ids(result),
      mode: "enforce", task_type: taskType, status: "ok",
      ...cost(result),
    });

    remember(`plan-mp-${workflowId}`, workflowId, result, taskType);

    return {
      id: `plan-mp-${workflowId}`,
      goal,
      steps,
      createdAt: now(),
      source: "remote",
      ...(rejections.length ? { rejections } : {}),
      rationale: [
        describeAnswer(result),
        parsed.plan.action,
        parsed.plan.reason ?? "",
      ].filter(Boolean).join(" · "),
    };
  }

  async function handleUnavailable(
    goal: Goal, workflowId: string, taskType: string, error: ModelPilotError,
  ): Promise<Plan> {
    const reason = `${error.kind}: ${error.message}`;
    log({
      local_workflow_id: workflowId, mode: opts.mode, task_type: taskType, status: "error",
      fallback_reason: reason,
    });
    // `unusable_output` never arrives here — it is handled above, where the
    // answer is known — so everything at this point is an availability problem,
    // and falling back is a decision the host made.
    if (opts.mode === "shadow" || (opts.onUnavailable ?? "local") === "local") {
      return withWorkflow(await local.plan(goal), workflowId, reason);
    }
    return {
      id: `plan-mp-refused-${workflowId}`,
      goal, steps: [], createdAt: now(),
      unreachable: goal.desiredState,
      rationale: `ModelPilot unavailable and this host is configured to refuse: ${reason}`,
    };
  }

  function refused(goal: Goal, workflowId: string, result: ModelPilotAnswer, why: string): Plan {
    // An unusable answer is still an answer ModelPilot billed for, and a
    // rejection is the one verdict its own telemetry can never derive.
    remember(`plan-mp-refused-${workflowId}`, workflowId, result, taskTypeOf(goal));
    return {
      id: `plan-mp-refused-${workflowId}`,
      goal,
      steps: [],
      createdAt: now(),
      unreachable: goal.desiredState,
      rejections: [{ capabilityId: "modelpilot", reason: why }],
      rationale: [
        why,
        // The one id that can be looked up afterwards — and the one
        // `/v1/feedback` takes.
        `request=${result.requestId ?? "unknown"}`,
        `model=${result.selectedModel ?? "unknown"}`,
      ].join(" · "),
    };
  }

  /** Note a plan whose outcome is worth posting back, oldest dropped first. */
  function remember(
    planId: string, workflowId: string, result: ModelPilotAnswer, taskType: string,
  ): void {
    if (!result.requestId) return;      // nothing to post it against
    pending.set(planId, {
      workflowId, requestId: result.requestId, taskType,
      ...(result.selectedModel ? { selectedModel: result.selectedModel } : {}),
    });
    while (pending.size > MAX_PENDING_VERDICTS) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
  }

  async function report(outcome: PlanOutcome): Promise<void> {
    const entry = pending.get(outcome.plan.id);
    // Not ours, or already reported. Both are ordinary: a host wires this to
    // every plan the agent finishes, and most of them are local.
    if (!entry) return;
    pending.delete(outcome.plan.id);

    const verdict = verdictFor(outcome);
    const local = {
      local_workflow_id: entry.workflowId,
      modelpilot_request_id: entry.requestId,
      ...(entry.selectedModel ? { selected_model: entry.selectedModel } : {}),
      mode: opts.mode, task_type: entry.taskType,
      local_action_result: outcome.outcomes.map((o) => `${o.step.action.capabilityId}:${o.status}`),
    } as const;

    if (!verdict) {
      // The honest gap, recorded so it is countable: how often this runtime
      // cannot tell ModelPilot anything is itself a number worth having.
      log({
        ...local, status: "outcome", local_final_verification: "not_run",
        fallback_reason: "nothing certain enough to report",
      });
      return;
    }

    try {
      await opts.client?.reportOutcome(
        entry.requestId,
        { success: verdict.success, comment: verdict.comment },
        opts.signal ? { signal: opts.signal } : {},
      );
      log({
        ...local, status: "outcome",
        local_final_verification: verdict.success ? "passed" : "failed",
      });
    } catch (err) {
      // A verdict that does not arrive changes nothing on the television. It is
      // worth exactly one telemetry line and no retry: the next plan matters
      // more than this bookkeeping.
      const error = err instanceof ModelPilotError ? `${err.kind}: ${err.message}` : String(err);
      log({
        ...local, status: "outcome",
        local_final_verification: verdict.success ? "passed" : "failed",
        fallback_reason: `feedback not delivered — ${error}`,
      });
    }
  }

  return {
    plan,
    report,
    get shadow() {
      return shadow;
    },
  };
}

/** The same label `plan()` uses, so the two telemetry rows join on more than an id. */
function taskTypeOf(goal: Goal): string {
  return goal.id;
}

/**
 * A validated action plan as executable steps.
 *
 * The action vocabulary is mapped onto capability ids and then *looked up*: a
 * capability this device does not have, or arguments that fail its schema, is a
 * rejection rather than a step. `ask_user` and `no_op` are legitimate answers
 * that produce no steps at all — an engine deciding it needs a human is a
 * success, not a failure to plan.
 */
export function toSteps(
  plan: TvActionPlan,
  graph: CapabilityGraph,
): { steps: PlanStep[]; rejections: PlanRejection[] } {
  const rejections: PlanRejection[] = [];
  const mapped = mapAction(plan);

  if (!mapped) {
    // ask_user / no_op, or an action with no capability on this device.
    if (plan.action !== "ask_user" && plan.action !== "no_op") {
      rejections.push({
        capabilityId: plan.action,
        reason: `no capability on this device performs "${plan.action}"`,
      });
    }
    return { steps: [], rejections };
  }

  const capability = graph.get(mapped.capabilityId);
  if (!capability || capability.status === "withdrawn") {
    rejections.push({
      capabilityId: mapped.capabilityId,
      args: mapped.args,
      reason: capability ? `${mapped.capabilityId} was withdrawn on this device` : `no such capability: ${mapped.capabilityId}`,
    });
    return { steps: [], rejections };
  }

  let args: Record<string, unknown>;
  try {
    args = validateArgs(
      { name: capability.tool ?? capability.id, description: capability.description, parameters: capability.parameters },
      mapped.args,
    );
  } catch (err) {
    rejections.push({ capabilityId: capability.id, args: mapped.args, reason: (err as Error).message });
    return { steps: [], rejections };
  }
  if (!callable(capability, args)) {
    rejections.push({ capabilityId: capability.id, args, reason: "a required argument is missing" });
    return { steps: [], rejections };
  }

  return { steps: [buildStep(graph, capability, args)], rejections };
}

/** The TV action vocabulary, mapped onto capability ids and arguments. */
function mapAction(plan: TvActionPlan): { capabilityId: string; args: Record<string, unknown> } | undefined {
  const p = plan.parameters ?? {};
  switch (plan.action) {
    case "set_input": {
      const source = str(p.source ?? p.input ?? p.value);
      return source ? { capabilityId: "tv.input.switch", args: { source } } : undefined;
    }
    case "set_volume": {
      const level = num(p.level ?? p.volume ?? p.value);
      return level === undefined ? undefined : { capabilityId: "tv.audio.set_volume", args: { level } };
    }
    case "play_content": {
      const uri = str(p.uri ?? p.url ?? p.content);
      // No uri means the engine has not said *what* to play. That is an
      // ask_user, not a guess — playing something unasked-for is exactly the
      // kind of action a household notices.
      return uri ? { capabilityId: "content.play", args: { uri } } : undefined;
    }
    case "pause":
      return { capabilityId: "content.pause", args: {} };
    case "power":
      // Declared in the capability tree, implemented by no adapter: `powerStandby`
      // needs a system permission on Android and a partner certificate on Tizen.
      // Mapping it to nothing is honest; the rejection says so.
      return undefined;
    case "ask_user":
    case "no_op":
      return undefined;
  }
}

function describeStep(step: PlanStep): string {
  const args = Object.entries(step.action.args).map(([k, v]) => `${k}=${String(v)}`).join(",");
  return `${step.action.capabilityId}(${args})`;
}

function compare(localSteps: string[], remoteSteps: string[]): NonNullable<ModelPilotTelemetry["shadow_agreement"]> {
  if (!localSteps.length && !remoteSteps.length) return "same";
  if (!remoteSteps.length) return "local_only";
  if (!localSteps.length) return "remote_only";
  return localSteps.join("|") === remoteSteps.join("|") ? "same" : "different";
}

function withWorkflow(plan: Plan, workflowId: string, fallbackReason?: string): Plan {
  const note = fallbackReason ? `local plan (ModelPilot fallback: ${fallbackReason})` : "local plan";
  return {
    ...plan,
    // A local plan produced *because the engine could not answer* is a different
    // number from one produced because the graph closed the goal: the first still
    // cost a network round trip.
    ...(fallbackReason ? { source: "local-fallback" as const } : {}),
    rationale: [plan.rationale, `${note} · ${workflowId}`].filter(Boolean).join(" · "),
  };
}

function ids(result: ModelPilotAnswer): Partial<ModelPilotTelemetry> {
  return {
    ...(result.requestId ? { modelpilot_request_id: result.requestId } : {}),
    ...(result.selectedModel ? { selected_model: result.selectedModel } : {}),
  };
}

/**
 * The numbers, in one place, so the three log sites cannot drift apart.
 *
 * `baseline_cost` is the service's claim about what the priciest eligible
 * candidate would have cost. Recording it beside `actual_cost` is what turns
 * "routing saves money" from a slogan into a subtractable pair.
 */
function cost(result: ModelPilotAnswer): Partial<ModelPilotTelemetry> {
  return {
    latency_ms: result.latencyMs,
    ...(result.actualCost !== undefined ? { actual_cost: result.actualCost } : {}),
    ...(result.baselineCost !== undefined ? { baseline_cost: result.baselineCost } : {}),
    ...(result.fallbackCount !== undefined ? { fallback_count: result.fallbackCount } : {}),
    ...(result.evaluationStatus ? { evaluation_status: result.evaluationStatus } : {}),
    ...(result.missing.length ? { missing_fields: result.missing } : {}),
  };
}

/**
 * Which call produced this plan, and which model answered.
 *
 * Both halves are needed on a bring-up screen: the request id is what
 * `/v1/feedback` and the tenant dashboard take, and the model is the answer to
 * "why was this plan good/bad/expensive" more often than anything else.
 */
function describeAnswer(result: ModelPilotAnswer): string {
  const via = result.selectedModel ? ` via ${result.selectedModel}` : "";
  return `modelpilot(${result.requestId ?? "no request id"}${via})`;
}

function record(list: ShadowRecord[], entry: ShadowRecord): void {
  list.push(entry);
  if (list.length > MAX_SHADOW_RECORDS) list.shift();
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Re-exported so a host can type its own capability lookups. */
export type { Capability };
