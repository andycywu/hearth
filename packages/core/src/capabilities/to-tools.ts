import type { Tool, ToolSpec } from "../tools/registry.js";
import { tvOk, classifyToolError } from "../tools/result.js";
import type { Capability } from "./types.js";

/**
 * Project capabilities into the tools the model is offered.
 *
 * The direction matters. Before this, the tool list was written by hand and the
 * capability catalogue described it afterwards — two lists saying the same thing,
 * which is fine until they disagree, and the failure mode when they do is
 * invisible: the planner reasons about a capability the model was never offered,
 * or the model is offered a tool the policy engine has never heard of.
 *
 * So the capability is the source of truth for everything declarative — name,
 * description, parameters, whether it needs confirming — and a handler supplies
 * only the part that cannot be data: the call into the platform.
 *
 * A capability with no handler is simply not projected. That is how a purely
 * declarative entry works — `ps5.power.on` exists in the graph on a TV with no
 * CEC transport, so the planner can say "I know what that would be, and I have
 * no way to do it" instead of pretending the console is not there.
 */

export type CapabilityHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolProjectionOptions {
  /** Called for a capability that declares a tool nothing implements. */
  onUnimplemented?: (capability: Capability) => void;
}

export function toolsFromCapabilities(
  capabilities: Capability[],
  handlers: Record<string, CapabilityHandler>,
  opts: ToolProjectionOptions = {},
): Tool[] {
  const tools: Tool[] = [];
  for (const capability of capabilities) {
    if (!capability.tool) continue;
    const handler = handlers[capability.id];
    if (!handler) {
      opts.onUnimplemented?.(capability);
      continue;
    }
    tools.push({ spec: toolSpecFor(capability), execute: inTvEnvelope(handler) });
  }
  return tools;
}

/**
 * The model-facing spec for one capability.
 *
 * `confirm` is derived from the risk level rather than set per tool, which is
 * what stops the two from drifting: a capability that someone marks `medium`
 * because it interrupts what is on screen cannot then quietly run unprompted
 * because nobody remembered the boolean.
 */
export function toolSpecFor(capability: Capability): ToolSpec {
  return {
    name: capability.tool ?? capability.id,
    description: capability.description,
    parameters: capability.parameters,
    ...(capability.riskLevel === "low" ? {} : { confirm: true }),
  };
}

/**
 * One envelope for every tool result, and the typed taxonomy for every failure.
 *
 * Applied here rather than in each handler for the reason it always was: there
 * are fifteen of them, the wrapping is identical, and a handler author should be
 * writing "what the TV did", not error classification. An adapter that throws —
 * which all of them still do — produces a classified result with no adapter
 * change.
 */
function inTvEnvelope(handler: CapabilityHandler): CapabilityHandler {
  return async (args) => {
    try {
      return tvOk(await handler(args));
    } catch (err) {
      return classifyToolError(err);
    }
  };
}
