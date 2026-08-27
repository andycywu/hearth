import {
  buildStep, callable, GoalPlanner, validateArgs,
  type Capability, type CapabilityGraph, type DeviceGraph, type Goal, type Plan,
  type PlanRejection, type PlanStep, type Planner, type PolicyEngine, type WorldModel,
} from "@hearthkit/core";
import { isVerified, type ModelPilotClient, type ModelPilotTaskResult } from "./client.js";
import { ModelPilotError } from "./errors.js";
import type { ModelPilotMode } from "./config.js";
import { parseActionPlan, type TvActionPlan } from "./action-plan.js";
import { buildTaskRequest } from "./task-mapper.js";
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
 * TV does not have, and cannot mark its own work as verified.
 *
 * The modes:
 *
 *  - **off** — never calls. The local planner answers, as before.
 *  - **shadow** (default) — calls, records the suggestion and the trajectory id,
 *    compares it with the local plan, and **executes the local one**. Device
 *    behaviour is byte-identical to `off`; the only difference is a telemetry
 *    record and a network call.
 *  - **enforce** — the returned plan is what runs, after local validation and
 *    with local policy still deciding whether each step may happen.
 *
 * Fallback, stated rather than implied: when ModelPilot is *unavailable*
 * (timeout, unreachable, 5xx, unauthorised, not configured) enforce mode falls
 * back to the local planner and records why. When ModelPilot is *reached* and
 * answers something unusable — a malformed plan, or a task it reports as
 * unverified — that is not an availability problem and there is no quiet
 * fallback: the plan comes back empty with the reason attached, which sends the
 * agent to recovery or to the user. Policy is never bypassed either way, because
 * policy runs in the executor, below both planners.
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
  /** Ceiling handed to ModelPilot and echoed in telemetry. */
  maxTaskBudget?: number;
  maxLatencyMs?: number;
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
  taskId?: string;
  trajectoryId?: string;
  suggestion?: TvActionPlan;
  agreement: NonNullable<ModelPilotTelemetry["shadow_agreement"]>;
  localSteps: string[];
  remoteSteps: string[];
}

export interface ModelPilotPlanner extends Planner {
  /** Shadow-mode suggestions, newest last. Bounded; nothing is persisted. */
  readonly shadow: readonly ShadowRecord[];
}

const MAX_SHADOW_RECORDS = 20;

export function createModelPilotPlanner(opts: ModelPilotPlannerOptions): ModelPilotPlanner {
  const now = opts.now ?? (() => Date.now());
  const log = createTelemetryLogger(opts.telemetry);
  const shadow: ShadowRecord[] = [];
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

    const request = buildTaskRequest({
      goal, world: opts.world, devices: opts.devices, capabilities: opts.graph,
      ...(goal.intent ? { utterance: goal.intent } : {}),
      ...(opts.maxTaskBudget !== undefined ? { maxTaskBudget: opts.maxTaskBudget } : {}),
      ...(opts.maxLatencyMs !== undefined ? { maxLatencyMs: opts.maxLatencyMs } : {}),
    });

    let result: ModelPilotTaskResult;
    try {
      result = await opts.client.executeVerifiedTask(
        request,
        opts.signal ? { signal: opts.signal } : {},
      );
    } catch (err) {
      const error = err instanceof ModelPilotError
        ? err
        : new ModelPilotError("server", String((err as Error)?.message ?? err));
      return handleUnavailable(goal, workflowId, taskType, error);
    }

    // Reached, but ModelPilot itself is not satisfied. No device operation, and
    // no substituting our own plan for the answer we asked it to stand behind.
    if (!isVerified(result)) {
      log({
        local_workflow_id: workflowId,
        ...ids(result),
        mode: opts.mode, task_type: taskType, status: "unverified",
        latency_ms: result.latencyMs,
        ...(result.actualCost !== undefined ? { actual_cost: result.actualCost } : {}),
        verification_result: result.status ?? "unknown",
        ...(result.missing.length ? { missing_fields: result.missing } : {}),
      });
      if (opts.mode === "shadow") return withWorkflow(await local.plan(goal), workflowId);
      return refused(goal, workflowId, result, `ModelPilot reported the task ${result.status ?? "unverified"}`);
    }

    const parsed = parseActionPlan(result.output);
    if (!parsed.ok) {
      log({
        local_workflow_id: workflowId,
        ...ids(result),
        mode: opts.mode, task_type: taskType, status: "unusable_output",
        latency_ms: result.latencyMs,
        ...(result.actualCost !== undefined ? { actual_cost: result.actualCost } : {}),
        verification_result: result.status ?? "unknown",
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
        ...(result.taskId ? { taskId: result.taskId } : {}),
        ...(result.trajectoryId ? { trajectoryId: result.trajectoryId } : {}),
      });
      log({
        local_workflow_id: workflowId,
        ...ids(result),
        mode: "shadow", task_type: taskType, status: "ok",
        latency_ms: result.latencyMs,
        ...(result.actualCost !== undefined ? { actual_cost: result.actualCost } : {}),
        verification_result: result.status ?? "verified",
        shadow_agreement: agreement,
        ...(result.missing.length ? { missing_fields: result.missing } : {}),
      });
      // The whole point of shadow: the device does exactly what it did before.
      return withWorkflow(localPlan, workflowId);
    }

    log({
      local_workflow_id: workflowId,
      ...ids(result),
      mode: "enforce", task_type: taskType, status: "ok",
      latency_ms: result.latencyMs,
      ...(result.actualCost !== undefined ? { actual_cost: result.actualCost } : {}),
      verification_result: result.status ?? "verified",
      ...(result.missing.length ? { missing_fields: result.missing } : {}),
    });

    return {
      id: `plan-mp-${workflowId}`,
      goal,
      steps,
      createdAt: now(),
      ...(rejections.length ? { rejections } : {}),
      rationale: [
        `modelpilot(${result.taskId ?? "no task id"})`,
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
    // `unusable_output` and `unverified` never arrive here — they are handled
    // above, where the answer is known — so everything at this point is an
    // availability problem, and falling back is a decision the host made.
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

  function refused(goal: Goal, workflowId: string, result: ModelPilotTaskResult, why: string): Plan {
    return {
      id: `plan-mp-refused-${workflowId}`,
      goal,
      steps: [],
      createdAt: now(),
      unreachable: goal.desiredState,
      rejections: [{ capabilityId: "modelpilot", reason: why }],
      rationale: [
        why,
        `task=${result.taskId ?? "unknown"}`,
        `trajectory=${result.trajectoryId ?? "unknown"}`,
      ].join(" · "),
    };
  }

  return {
    plan,
    get shadow() {
      return shadow;
    },
  };
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
  return { ...plan, rationale: [plan.rationale, `${note} · ${workflowId}`].filter(Boolean).join(" · ") };
}

function ids(result: ModelPilotTaskResult): Partial<ModelPilotTelemetry> {
  return {
    ...(result.taskId ? { modelpilot_task_id: result.taskId } : {}),
    ...(result.trajectoryId ? { trajectory_id: result.trajectoryId } : {}),
  };
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
