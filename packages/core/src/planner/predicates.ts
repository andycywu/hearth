import type { StatePredicate } from "../capabilities/types.js";
import type { WorldModel } from "../world/model.js";

/**
 * Evaluating conditions against what the agent believes, with "I don't know" as
 * a first-class third answer.
 *
 * Two-valued logic is what makes command mapping brittle: treating unknown as
 * false makes the agent refuse to act at boot, when it knows nothing; treating
 * it as true makes it act on nothing. The planner needs to tell the two apart so
 * it can insert an *observation* step instead of guessing either way.
 */
export type Truth = "true" | "false" | "unknown";

export function evaluate(world: WorldModel, predicate: StatePredicate): Truth {
  if (!world.known(predicate.path)) return predicate.unknownOk ? "true" : "unknown";
  const value = world.value(predicate.path);

  if (predicate.equals !== undefined) {
    // Tolerance first: a quantised control that landed on the nearest step it has
    // did what was asked, and failing it would send someone to debug a TV that is
    // working exactly as designed.
    if (predicate.within !== undefined && typeof value === "number") {
      const target = Number(predicate.equals);
      return bool(Number.isFinite(target) && Math.abs(value - target) <= predicate.within);
    }
    return bool(looseEquals(value, predicate.equals));
  }
  if (predicate.notEquals !== undefined) return bool(!looseEquals(value, predicate.notEquals));
  if (predicate.oneOf !== undefined) return bool(predicate.oneOf.some((v) => looseEquals(value, v)));
  if (predicate.gte !== undefined) return bool(typeof value === "number" && value >= predicate.gte);
  if (predicate.lte !== undefined) return bool(typeof value === "number" && value <= predicate.lte);
  return "true"; // bare path: knowing it at all satisfies the predicate
}

/** All predicates true? Unknown counts as not-yet-satisfied, never as failed. */
export function allTrue(world: WorldModel, predicates: StatePredicate[]): boolean {
  return predicates.every((p) => evaluate(world, p) === "true");
}

/** The predicates that are not yet true — the gap a plan has to close. */
export function unsatisfied(world: WorldModel, predicates: StatePredicate[]): StatePredicate[] {
  return predicates.filter((p) => evaluate(world, p) !== "true");
}

/**
 * The value a predicate is asking for, if it names one.
 *
 * Used to turn a desired state into an argument: `{ path: "tv.input", equals:
 * "hdmi2" }` is what tells `tv.input.switch` what to switch *to*.
 */
export function targetValue(predicate: StatePredicate): unknown {
  if (predicate.equals !== undefined) return predicate.equals;
  if (predicate.oneOf?.length) return predicate.oneOf[0];
  // A bound is a target: "at most 20" is achieved by setting 20, and without
  // this a bounded goal produced no argument, so `night_mode` — which has always
  // been written as `lte` — was silently unplannable. Nothing noticed until a
  // relative volume goal was expressed the same way.
  if (predicate.lte !== undefined) return predicate.lte;
  if (predicate.gte !== undefined) return predicate.gte;
  return undefined;
}

/**
 * Fill `{name}` templates from a bag of values.
 *
 * A bare `"{level}"` yields the *value*, not a string — `set_volume` takes a
 * number, and stringifying it here would push a coercion into every consumer.
 * Interpolation inside a longer string stays textual, as you would expect.
 */
export function interpolate(template: unknown, params: Record<string, unknown>): unknown {
  if (typeof template !== "string") return template;
  const whole = /^\{([A-Za-z_][\w]*)\}$/.exec(template);
  if (whole) return whole[1]! in params ? params[whole[1]!] : template;
  return template.replace(/\{([A-Za-z_][\w]*)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match);
}

export function interpolatePredicate(predicate: StatePredicate, params: Record<string, unknown>): StatePredicate {
  const out: StatePredicate = { ...predicate, path: String(interpolate(predicate.path, params)) };
  if (predicate.equals !== undefined) out.equals = interpolate(predicate.equals, params);
  if (predicate.notEquals !== undefined) out.notEquals = interpolate(predicate.notEquals, params);
  if (predicate.oneOf !== undefined) out.oneOf = predicate.oneOf.map((v) => interpolate(v, params));
  return out;
}

function bool(value: boolean): Truth {
  return value ? "true" : "false";
}

/**
 * Compare a world value with an expected one.
 *
 * Loose across the string/number and string/boolean divide on purpose: a device
 * bridge that reports `"30"` where the model asked for `30` has done what was
 * asked, and failing verification over the JSON type would send the executor
 * into a retry loop against a TV that is already correct.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "string") return String(a) === b.trim();
  if (typeof a === "string" && typeof b === "number") return a.trim() === String(b);
  if (typeof a === "boolean" && typeof b === "string") return String(a) === b.trim().toLowerCase();
  if (typeof a === "string" && typeof b === "boolean") return a.trim().toLowerCase() === String(b);
  return false;
}
