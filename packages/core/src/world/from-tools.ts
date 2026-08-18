import type { Capability } from "../capabilities/types.js";
import { tvResultData } from "../tools/result.js";
import type { Observation } from "./state.js";
import type { WorldModel } from "./model.js";

/**
 * Every tool result is an observation of the world — this is where that becomes
 * true rather than aspirational.
 *
 * The mapping lives on the capability (`reads: { volume: "tv.volume" }`) instead
 * of in a switch statement here, because a switch over tool names is a second
 * list that has to be kept in step with the first, and the failure mode when it
 * drifts is silent: the agent simply stops learning from a tool, and nobody
 * notices until it starts guessing.
 */
export function observationsFromResult(capability: Capability, result: unknown): Observation[] {
  const data = tvResultData(result);
  if (!capability.reads || data === undefined || data === null) return [];
  if (typeof data !== "object" || Array.isArray(data)) {
    // A scalar result maps only if the capability declares exactly one read;
    // otherwise we cannot tell which path it belongs to, and guessing would put
    // a wrong fact in the world at full confidence.
    const entries = Object.entries(capability.reads);
    return entries.length === 1
      ? [{ path: entries[0]![1], value: data, source: "tool" }]
      : [];
  }

  const out: Observation[] = [];
  for (const [field, path] of Object.entries(capability.reads)) {
    const value = (data as Record<string, unknown>)[field];
    if (value !== undefined) out.push({ path, value, source: "tool" });
  }
  return out;
}

/** Fold a tool result into the world. Returns how many facts it changed. */
export function observeResult(world: WorldModel, capability: Capability, result: unknown): number {
  let changed = 0;
  for (const obs of observationsFromResult(capability, result)) {
    if (world.observe(obs)) changed++;
  }
  return changed;
}
