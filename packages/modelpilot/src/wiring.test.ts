import { describe, expect, it } from "vitest";
import { Agent, WorldModel, type PlanOutcome } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createModelPilotWiring } from "./wiring.js";
import type { ModelPilotConfig } from "./config.js";

const config = (over: Partial<ModelPilotConfig> = {}): ModelPilotConfig & { apiKey: string } => ({
  mode: "shadow", baseUrl: "http://127.0.0.1:9", apiKey: "mp-test-key", timeoutMs: 500, maxTaskBudget: 0.05, source: "env", ...over,
});

describe("ModelPilot wiring, shared by the television host and the CLI", () => {
  it("builds a planner from the agent's own graph, once the agent asks for one", async () => {
    const wiring = createModelPilotWiring({ config: config(), installId: "install-1", runtimeVersion: "0.3.0" });
    const platform = createWebAdapter();
    await platform.init();
    let built = 0;
    const agent = new Agent({
      platform, world: new WorldModel(),
      planner: (ctx) => { built++; return wiring.factory(ctx); },
      llmPlanning: true,
    });
    expect(agent).toBeDefined();
    expect(built).toBe(1);                              // the agent builds it; the host never sees the instance
  });

  it("has nothing to report before a plan exists — a plan finished before there was a planner was not ModelPilot's", async () => {
    const wiring = createModelPilotWiring({ config: config(), installId: "i", runtimeVersion: "0.3.0" });
    await expect(wiring.report({ plan: { id: "p", goal: { id: "g", desiredState: [] }, steps: [], createdAt: 0 }, outcomes: [], achieved: true, unmet: [] } as PlanOutcome)).resolves.toBeUndefined();
  });
});
