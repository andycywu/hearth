import type { PlanOutcome, PlannerContext } from "@hearthkit/core";
import { createModelPilotClient } from "./client.js";
import type { ModelPilotConfig } from "./config.js";
import { createModelPilotPlanner, type ModelPilotPlanner } from "./planner.js";

/**
 * ModelPilot, as the two things a host hands to its agent: a planner factory and a
 * way to close the loop.
 *
 * Both hosts that run the agent — the television's boot sequence and the CLI on a Pi
 * — need exactly this and neither has anything to say about how the config was found,
 * so it lives here, free of any DOM or process object.
 *
 * **A factory, not an instance**, so the planner reasons over the agent's own
 * capability graph — the one the boot probe withdraws from, not a copy that would keep
 * proposing capabilities this build has already given up on. It follows that the host
 * never sees the instance, and the instance is the only thing that knows which
 * ModelPilot request a finished plan came from; capturing it here is what lets
 * `plan:end` reach `/v1/feedback` without the planner holding a reference back to the
 * agent that owns it.
 */
export interface ModelPilotWiring {
  factory: (ctx: PlannerContext) => ModelPilotPlanner;
  /**
   * Report a finished plan to `/v1/feedback`, which is how ModelPilot learns whether the
   * task it routed succeeded — its metric is cost per *successful* task and it does not
   * count a completed API call as one. Before the first plan there is no instance, and a
   * plan the agent finished before one existed cannot have been ModelPilot's.
   */
  report: (outcome: PlanOutcome) => Promise<void>;
  /**
   * Wait for the shadow calls still in flight. A long-lived host never needs it; a one-shot command does, or the
   * process ends before the call it started behind the answer has been logged. Bounded by the client's timeout.
   */
  settled: () => Promise<void>;
}

export interface ModelPilotWiringOptions {
  /** Must carry a key: a config without one is "off" and must not be wired. */
  config: ModelPilotConfig & { apiKey: string };
  installId: string;
  runtimeVersion: string;
  telemetry?: (record: unknown) => void;
  /** Wait for the service in shadow mode too (a measurement run). Default: shadow answers locally at once. */
  blockingShadow?: boolean;
}

export function createModelPilotWiring(o: ModelPilotWiringOptions): ModelPilotWiring {
  const { config } = o;
  let instance: ModelPilotPlanner | undefined;
  return {
    factory: (ctx) => (instance = createModelPilotPlanner({
      client: createModelPilotClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        identity: { installId: o.installId, runtimeVersion: o.runtimeVersion, mode: config.mode },
      }),
      mode: config.mode,
      graph: ctx.capabilities,
      world: ctx.world,
      devices: ctx.devices,
      meter: ctx.meter,
      maxTaskBudget: config.maxTaskBudget,
      ...(o.blockingShadow ? { blockingShadow: true } : {}),
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(o.telemetry ? { telemetry: o.telemetry } : {}),
    })),
    report: async (outcome) => instance?.report(outcome),
    settled: async () => instance?.settled(),
  };
}
