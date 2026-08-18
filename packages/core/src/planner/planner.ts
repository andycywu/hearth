import type { Capability, StateEffect, StatePredicate } from "../capabilities/types.js";
import type { CapabilityGraph } from "../capabilities/graph.js";
import { isTemplate } from "../capabilities/graph.js";
import { WorldModel } from "../world/model.js";
import { evaluate, interpolate, targetValue, unsatisfied } from "./predicates.js";
import type { Goal, Plan, PlanStep, Planner } from "./types.js";

/**
 * Goal-based planning: the difference between the world we want and the world we
 * have, closed by capabilities chosen from the graph.
 *
 * The search is backwards and deliberately shallow. For each unsatisfied
 * desired predicate we ask the Capability Graph which capabilities *declare* an
 * effect on that path, take the best-ranked one, and derive its arguments from
 * the predicate's target value. One level of precondition chasing follows, which
 * is enough for every living-room plan we have met — "switch input" needs "TV
 * on", and that is where it stops. A full regression planner would be more
 * general and much harder to trust; when a domain turns up that needs it, the
 * `Planner` interface is where it plugs in, alongside the LLM planner rather
 * than instead of it.
 *
 * What this class must never do is know what an HDMI port is. It knows paths,
 * predicates and capability ids.
 */

export interface GoalPlannerOptions {
  graph: CapabilityGraph;
  world: WorldModel;
  now?: () => number;
  /** Cap on steps, so a bad goal cannot produce a plan nobody wants to run. */
  maxSteps?: number;
}

export class GoalPlanner implements Planner {
  private readonly graph: CapabilityGraph;
  private readonly world: WorldModel;
  private readonly now: () => number;
  private readonly maxSteps: number;

  constructor(opts: GoalPlannerOptions) {
    this.graph = opts.graph;
    this.world = opts.world;
    this.now = opts.now ?? (() => Date.now());
    this.maxSteps = opts.maxSteps ?? 12;
  }

  async plan(goal: Goal): Promise<Plan> {
    const params = goal.params ?? {};
    const want = goal.desiredState.map((p) => resolve(p, params));
    const optional = (goal.optional ?? []).map((p) => resolve(p, params));

    // Simulated world: the plan is built against the state each step *will*
    // leave behind, so step 4 can depend on step 3 having happened. Effects are
    // recorded with `override` because inside the simulation they are
    // definitionally true — this copy never touches the real world model.
    const sim = new WorldModel({ now: this.now });
    sim.restore(this.world.dump());

    const steps: PlanStep[] = [];
    const unreachable: StatePredicate[] = [];

    for (const predicate of [...want, ...optional]) {
      const isOptional = optional.includes(predicate);
      if (evaluate(sim, predicate) === "true") continue;

      const capability = this.choose(predicate);
      if (!capability) {
        // An optional predicate nothing can reach is simply dropped; a required
        // one is reported, so the user hears "I can't set game mode on this TV"
        // rather than watching a plan quietly do four fifths of the job.
        if (!isOptional) unreachable.push(predicate);
        continue;
      }

      for (const step of this.stepsFor(capability, predicate, sim, isOptional)) {
        if (steps.length >= this.maxSteps) break;
        steps.push(step);
        applyEffects(sim, step.expectedResult);
      }
    }

    return {
      id: `plan-${this.now().toString(36)}-${steps.length}`,
      goal,
      steps: order(steps, goal.preferredOrder),
      createdAt: this.now(),
      ...(unreachable.length ? { unreachable } : {}),
      rationale: describe(goal, steps),
    };
  }

  /** Best capability that produces this predicate's path, if any. */
  private choose(predicate: StatePredicate): Capability | undefined {
    const target = targetValue(predicate);
    const direct = this.graph.achieving(predicate.path, target);
    return direct[0];
  }

  /**
   * One capability, plus at most one round of precondition satisfaction.
   *
   * A precondition that is merely *unknown* becomes a read step rather than a
   * failure — "I don't know whether the TV is on" is answered by looking, and an
   * agent that refuses to act until someone tells it is not much use at boot.
   */
  private stepsFor(
    capability: Capability,
    predicate: StatePredicate,
    sim: WorldModel,
    optional: boolean,
  ): PlanStep[] {
    const out: PlanStep[] = [];
    const args = argsFor(capability, predicate);

    for (const pre of capability.preconditions ?? []) {
      const truth = evaluate(sim, pre);
      if (truth === "true") continue;
      const fixer = truth === "unknown"
        ? this.graph.reading(pre.path)[0]
        : this.graph.achieving(pre.path, targetValue(pre))[0];
      if (!fixer || fixer.id === capability.id) continue;
      out.push(this.step(fixer, truth === "unknown" ? {} : argsFor(fixer, pre), true));
    }

    out.push(this.step(capability, args, optional));
    return out;
  }

  private step(capability: Capability, args: Record<string, unknown>, optional: boolean): PlanStep {
    const alternates = this.graph.providers(capability.id)
      .filter((c) => c.provider !== capability.provider && c.status !== "withdrawn")
      .map((c) => ({ capabilityId: c.id, args }));

    return {
      id: `${capability.id}#${Object.values(args).join(",")}`,
      action: { capabilityId: capability.id, args },
      preconditions: (capability.preconditions ?? []).map((p) => resolve(p, args)),
      expectedResult: (capability.sideEffects ?? []).map((e) => ({ ...e, set: interpolate(e.set, args) })),
      ...(capability.verification ? { verification: resolveVerification(capability, args) } : {}),
      ...(alternates.length ? { fallbacks: alternates } : {}),
      ...(optional ? { optional } : {}),
      maxRetries: 1,
    };
  }
}

/**
 * Arguments for a capability, derived from the state it is being asked to
 * produce.
 *
 * `{ path: "tv.input", equals: "hdmi2" }` plus an effect of
 * `{ path: "tv.input", set: "{source}" }` yields `{ source: "hdmi2" }`. This is
 * the mechanism that keeps port names out of the planner: the capability says
 * which parameter drives which path, and the goal says what the path should
 * become.
 */
export function argsFor(capability: Capability, predicate: StatePredicate): Record<string, unknown> {
  const target = targetValue(predicate);
  const args: Record<string, unknown> = {};
  for (const effect of capability.sideEffects ?? []) {
    if (effect.path !== predicate.path || !isTemplate(effect.set)) continue;
    const param = String(effect.set).slice(1, -1);
    if (target !== undefined) args[param] = target;
  }
  return args;
}

function resolve(predicate: StatePredicate, params: Record<string, unknown>): StatePredicate {
  const out: StatePredicate = { ...predicate, path: String(interpolate(predicate.path, params)) };
  if (predicate.equals !== undefined) out.equals = interpolate(predicate.equals, params);
  if (predicate.notEquals !== undefined) out.notEquals = interpolate(predicate.notEquals, params);
  if (predicate.oneOf !== undefined) out.oneOf = predicate.oneOf.map((v) => interpolate(v, params));
  return out;
}

function resolveVerification(capability: Capability, args: Record<string, unknown>): Capability["verification"] {
  const v = capability.verification!;
  if (v.kind === "read_back") return { ...v, predicate: resolve(v.predicate, args) };
  if (v.kind === "state") return { ...v, predicate: resolve(v.predicate, args) };
  return v;
}

function applyEffects(sim: WorldModel, effects: StateEffect[]): void {
  for (const effect of effects) {
    sim.observe({ path: effect.path, value: effect.set, source: "assumed", confidence: 1, override: true });
  }
}

/** Honour a skill's stated order; anything unlisted keeps its planned position. */
function order(steps: PlanStep[], preferred?: string[]): PlanStep[] {
  if (!preferred?.length) return steps;
  const rank = (step: PlanStep): number => {
    const i = preferred.indexOf(step.action.capabilityId);
    return i === -1 ? preferred.length : i;
  };
  return [...steps].sort((a, b) => rank(a) - rank(b));
}

function describe(goal: Goal, steps: PlanStep[]): string {
  return steps.length
    ? `${goal.id}: ${steps.map((s) => s.action.capabilityId).join(" -> ")}`
    : `${goal.id}: already satisfied`;
}

/** Which desired predicates are still false — the honest answer after a run. */
export function remainingGap(world: WorldModel, goal: Goal): StatePredicate[] {
  return unsatisfied(world, goal.desiredState.map((p) => resolve(p, goal.params ?? {})));
}
