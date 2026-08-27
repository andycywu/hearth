import { REQUIRED_KEYS } from "./task-mapper.js";

/**
 * The one shape a ModelPilot answer is allowed to have before it can touch a
 * television.
 *
 * Strict on purpose, and strict in the direction that matters: an answer we
 * cannot fully understand does **not** become a device operation. Everything
 * that fails here goes to recovery or to the user, with the ModelPilot task and
 * trajectory ids attached so the decision can be looked up afterwards.
 *
 * Note what this parser deliberately does not do: it does not repair. A missing
 * `expected_state` could be inferred, a `risk` could be defaulted to `low`, and
 * both would be us quietly writing the part of the answer we asked a remote
 * engine to be accountable for.
 */

export const TV_ACTIONS = [
  "set_input", "set_volume", "play_content", "pause", "power", "ask_user", "no_op",
] as const;
export type TvAction = (typeof TV_ACTIONS)[number];

export const RISKS = ["low", "medium", "high"] as const;
export type PlanRisk = (typeof RISKS)[number];

export interface TvActionPlan {
  action: TvAction;
  target: string;
  parameters: Record<string, unknown>;
  expected_state: Record<string, unknown>;
  risk: PlanRisk;
  reason?: string;
}

export type ParseResult =
  | { ok: true; plan: TvActionPlan }
  | { ok: false; errors: string[] };

/**
 * Parse whatever came back.
 *
 * Tolerant about *packaging* — a fenced block, a chatty preamble, a plan nested
 * under `output`/`result`/`data`/`plan` — and unforgiving about *content*. The
 * distinction matters: wrapping is the transport being a transport, while a
 * missing key is the answer being incomplete.
 */
export function parseActionPlan(input: unknown): ParseResult {
  const candidate = unwrap(input);
  if (candidate === undefined) return { ok: false, errors: ["no JSON object in the response"] };

  const errors: string[] = [];
  const obj = candidate as Record<string, unknown>;

  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) errors.push(`missing "${key}"`);
  }

  const action = obj.action;
  if (typeof action !== "string" || !TV_ACTIONS.includes(action as TvAction)) {
    errors.push(`"action" must be one of: ${TV_ACTIONS.join(", ")}`);
  }
  const target = obj.target;
  if (typeof target !== "string" || !target.trim()) errors.push('"target" must be a non-empty string');

  if (!isPlainObject(obj.parameters)) errors.push('"parameters" must be an object');
  if (!isPlainObject(obj.expected_state)) errors.push('"expected_state" must be an object');

  const risk = obj.risk;
  if (typeof risk !== "string" || !RISKS.includes(risk as PlanRisk)) {
    errors.push(`"risk" must be one of: ${RISKS.join(", ")}`);
  }
  if (obj.reason !== undefined && typeof obj.reason !== "string") {
    errors.push('"reason" must be a string when present');
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      action: action as TvAction,
      target: (target as string).trim(),
      parameters: obj.parameters as Record<string, unknown>,
      expected_state: obj.expected_state as Record<string, unknown>,
      risk: risk as PlanRisk,
      // Truncated: a reason is shown to a person and logged, and an unbounded
      // string from a remote service should not be either.
      ...(typeof obj.reason === "string" ? { reason: obj.reason.slice(0, 240) } : {}),
    },
  };
}

/** Find the plan object inside whatever envelope the service used. */
function unwrap(input: unknown): unknown {
  const seen = new Set<unknown>();
  let value = input;

  for (let depth = 0; depth < 6; depth++) {
    if (typeof value === "string") {
      const parsed = parseLoose(value);
      if (parsed === undefined) return undefined;
      value = parsed;
      continue;
    }
    if (!isPlainObject(value) || seen.has(value)) return undefined;
    seen.add(value);

    const obj = value as Record<string, unknown>;
    if ("action" in obj) return obj;

    const next = obj.output ?? obj.result ?? obj.plan ?? obj.data ?? obj.content;
    if (next === undefined) return undefined;
    value = next;
  }
  return undefined;
}

function parseLoose(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(slice);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
