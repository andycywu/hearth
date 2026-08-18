import type { Capability } from "../capabilities/types.js";
import type { CapabilityGraph } from "../capabilities/graph.js";
import type { LlmClient } from "../llm/client.js";
import type { PolicyEngine } from "../policy/policy.js";
import { validateArgs, type ToolSpec } from "../tools/registry.js";
import { WorldModel } from "../world/model.js";
import { buildStep, callable } from "./planner.js";
import { evaluate } from "./predicates.js";
import type { Goal, Plan, PlanRejection, PlanStep, Planner } from "./types.js";

/**
 * Planning by asking the model — with everything it proposes checked against the
 * Capability Graph before any of it runs.
 *
 * The deterministic planner closes a gap it can *measure*: desired predicates
 * against current ones. That covers the scenarios we wrote down and nothing else,
 * and a living room is mostly things nobody wrote down. This handles the long
 * tail, and the whole design question is how much of a plan a model is allowed to
 * author.
 *
 * The answer here is: the capability and the arguments, and nothing else. The
 * model does not write preconditions, expected effects, verification or
 * fallbacks — `buildStep` takes those from the graph. So a model cannot weaken a
 * check it was never asked to write, cannot claim an effect a capability does not
 * declare, and cannot invent a way to mark its own work as verified. What it can
 * do is choose badly, which is what the validation below is for.
 *
 * Five ways a proposal is thrown out, all before execution:
 *
 *  1. the capability does not exist, or this device withdrew it;
 *  2. the arguments do not fit its schema (same validator the tool layer uses,
 *     so an enum or a type error is caught here rather than mid-plan);
 *  3. a required argument is missing;
 *  4. a precondition is *false* and no earlier step in the plan makes it true;
 *  5. policy denies it outright.
 *
 * Rejections are recorded on the plan rather than dropped. A plan that quietly
 * lost half its steps looks like a plan that worked, and when the proposer is a
 * model, this is the only place the reason survives.
 */

export interface LlmPlannerOptions {
  llm: LlmClient;
  graph: CapabilityGraph;
  world: WorldModel;
  /** Consulted at plan time so a denied step never reaches the executor. */
  policy?: PolicyEngine;
  /** Cap on accepted steps. Default 8. */
  maxSteps?: number;
  /** Characters of world summary to include. Default 500. */
  worldChars?: number;
  now?: () => number;
}

interface ProposedStep {
  capability?: unknown;
  capabilityId?: unknown;
  args?: unknown;
  optional?: unknown;
}

export function createLlmPlanner(opts: LlmPlannerOptions): Planner {
  const now = opts.now ?? (() => Date.now());
  const maxSteps = opts.maxSteps ?? 8;

  return {
    async plan(goal: Goal): Promise<Plan> {
      const usable = opts.graph.usable().filter((c) => c.tool);
      const result = await opts.llm.complete({
        messages: [
          { role: "system", content: systemPrompt(usable, opts.world, opts.worldChars ?? 500) },
          { role: "user", content: userPrompt(goal) },
        ],
        // No tools: the model is writing a plan, not taking an action. Handing it
        // the tool list here would invite it to just do the thing, which is the
        // path that has no verification.
        tools: [],
      });

      const proposed = parseSteps(result.message.content);
      const steps: PlanStep[] = [];
      const rejections: PlanRejection[] = [];

      // Preconditions are judged against the state the accepted steps will leave
      // behind, so "switch input" after "power on" is fine while "switch input"
      // alone on a TV known to be off is not.
      const sim = new WorldModel({ now });
      sim.restore(opts.world.dump());

      for (const raw of proposed) {
        if (steps.length >= maxSteps) {
          rejections.push({ capabilityId: idOf(raw) ?? "?", reason: `more than ${maxSteps} steps` });
          continue;
        }
        const check = validate(raw, { ...opts, sim });
        if ("reason" in check) {
          // The proposed arguments go in the record even when the capability was
          // never real: "it tried to unlock a door with code 1234" is the useful
          // half of that rejection.
          const args = check.args ?? argsOf(raw);
          rejections.push({
            capabilityId: idOf(raw) ?? "?",
            ...(Object.keys(args).length ? { args } : {}),
            reason: check.reason,
          });
          continue;
        }
        const step = buildStep(opts.graph, check.capability, check.args, raw.optional === true);
        steps.push(step);
        for (const effect of step.expectedResult) {
          sim.observe({ path: effect.path, value: effect.set, source: "assumed", confidence: 1, override: true });
        }
      }

      return {
        id: `plan-llm-${now().toString(36)}-${steps.length}`,
        goal,
        steps,
        createdAt: now(),
        ...(rejections.length ? { rejections } : {}),
        rationale: `${goal.intent ?? goal.id}: ${steps.map((s) => s.action.capabilityId).join(" -> ") || "nothing runnable"}`,
      };
    },
  };
}

type Validated =
  | { capability: Capability; args: Record<string, unknown> }
  | { reason: string; args?: Record<string, unknown> };

function validate(
  raw: ProposedStep,
  ctx: { graph: CapabilityGraph; sim: WorldModel; policy?: PolicyEngine },
): Validated {
  const id = idOf(raw);
  if (!id) return { reason: "no capability named" };

  const capability = ctx.graph.get(id);
  if (!capability) return { reason: `no such capability on this device: ${id}` };
  if (capability.status === "withdrawn") return { reason: `${id} was withdrawn on this device` };

  const proposedArgs = argsOf(raw);

  // The tool layer's own validator, so a bad enum value or a string where a
  // number belongs is caught here — and coerced the same way it would be at
  // execution, rather than differently.
  let args: Record<string, unknown>;
  try {
    args = validateArgs(asToolSpec(capability), proposedArgs);
  } catch (err) {
    return { reason: (err as Error).message, args: proposedArgs };
  }
  if (!callable(capability, args)) {
    return { reason: `${id} is missing a required argument`, args };
  }

  for (const pre of capability.preconditions ?? []) {
    // Only a *false* precondition rejects. Unknown is a reason to look, not a
    // reason to refuse, and the executor settles it by acting and verifying.
    if (evaluate(ctx.sim, pre) === "false") {
      return { reason: `${id} needs ${pre.path} to be different first`, args };
    }
  }

  if (ctx.policy) {
    const decision = ctx.policy.check({ capability, args, actor: "agent", world: ctx.sim });
    if (decision.effect === "deny") return { reason: decision.reason, args };
  }

  return { capability, args };
}

/** Whatever the model put under `args`, if it is an object at all. */
function argsOf(raw: ProposedStep): Record<string, unknown> {
  return raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)
    ? raw.args as Record<string, unknown>
    : {};
}

function idOf(raw: ProposedStep): string | undefined {
  const id = raw.capability ?? raw.capabilityId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function asToolSpec(capability: Capability): ToolSpec {
  return {
    name: capability.tool ?? capability.id,
    description: capability.description,
    parameters: capability.parameters,
  };
}

function systemPrompt(capabilities: Capability[], world: WorldModel, worldChars: number): string {
  const lines = capabilities.map((c) => {
    const params = Object.entries(c.parameters)
      .map(([name, p]) => `${name}:${p.type}${p.required ? "" : "?"}${p.enum ? `(${p.enum.join("|")})` : ""}`)
      .join(", ");
    const pre = (c.preconditions ?? []).map((p) => p.path).join(", ");
    return `- ${c.id}(${params})${pre ? ` [needs: ${pre}]` : ""} — ${c.description}`;
  });
  const summary = world.summarize({ maxChars: worldChars });

  return [
    "You plan actions for an AI agent embedded in a television.",
    "",
    "Reply with JSON only, in this shape:",
    '{"steps":[{"capability":"<id>","args":{}}]}',
    "",
    "Rules:",
    "- Use only the capability ids listed below. Never invent one.",
    "- Order steps so each one's preconditions are met by the state before it.",
    "- Include only what is needed. An empty steps array is a valid answer when",
    "  nothing needs doing or nothing listed can do it.",
    "- Do not add fields. Verification and preconditions are not yours to write.",
    "",
    "Capabilities on this device:",
    ...lines,
    ...(summary ? ["", "What is already known about this room:", summary] : []),
  ].join("\n");
}

function userPrompt(goal: Goal): string {
  const parts = [`Goal: ${goal.intent ?? goal.id}`];
  if (goal.desiredState.length) {
    parts.push("Desired state:", ...goal.desiredState.map((p) => `- ${describePredicate(p)}`));
  }
  if (goal.optional?.length) {
    parts.push("Nice to have:", ...goal.optional.map((p) => `- ${describePredicate(p)}`));
  }
  return parts.join("\n");
}

function describePredicate(p: { path: string; equals?: unknown; lte?: number; gte?: number; notEquals?: unknown }): string {
  if (p.equals !== undefined) return `${p.path} = ${JSON.stringify(p.equals)}`;
  if (p.notEquals !== undefined) return `${p.path} != ${JSON.stringify(p.notEquals)}`;
  if (p.lte !== undefined) return `${p.path} <= ${p.lte}`;
  if (p.gte !== undefined) return `${p.path} >= ${p.gte}`;
  return p.path;
}

/**
 * Pull steps out of whatever the model actually said.
 *
 * Models fence their JSON, prefix it with "Sure!", and occasionally return the
 * array on its own. All three are recoverable, and none of them is worth failing
 * a turn over — while anything genuinely unparseable yields no steps, which is a
 * plan that does nothing rather than a plan that does something unintended.
 */
export function parseSteps(content: string): ProposedStep[] {
  const text = content.replace(/```(?:json)?/gi, "").trim();
  const candidates = [text, sliceBetween(text, "{", "}"), sliceBetween(text, "[", "]")];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      const steps = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown }).steps;
      if (Array.isArray(steps)) {
        return steps.filter((s): s is ProposedStep => !!s && typeof s === "object" && !Array.isArray(s));
      }
    } catch {
      /* try the next shape */
    }
  }
  return [];
}

function sliceBetween(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}
