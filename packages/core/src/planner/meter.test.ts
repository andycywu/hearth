import { describe, it, expect } from "vitest";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { Agent } from "../agent/agent.js";
import { PlanningMeter } from "./meter.js";
import { W } from "../world/state.js";
import type { Plan, Planner } from "./types.js";
import type { CompletionResult, LlmClient } from "../llm/client.js";

/**
 * The ratio this measures is a cost question: a deterministic plan is free, a
 * model-backed one is not, and on a television the difference between them
 * decides whether goal mode is affordable per household.
 */

const plan = (source: Plan["source"], steps = 1): Plan => ({
  id: `p-${source}`,
  goal: { id: "g", desiredState: [] },
  steps: Array.from({ length: steps }, (_, i) => ({
    id: `s${i}`, action: { capabilityId: "tv.audio.set_mute", args: {} },
    preconditions: [], expectedResult: [],
  })),
  createdAt: 0,
  ...(source ? { source } : {}),
});

describe("PlanningMeter", () => {
  it("counts nothing before anything is planned", () => {
    const meter = new PlanningMeter();
    expect(meter.snapshot().totalPlans).toBe(0);
    expect(meter.snapshot().zeroTokenRatio).toBeUndefined();
    expect(meter.describe()).toMatch(/nothing planned yet/);
  });

  it("reports the free share of planning", () => {
    const meter = new PlanningMeter();
    meter.record(plan("deterministic"));
    meter.record(plan("deterministic"));
    meter.record(plan("deterministic"));
    meter.record(plan("model"));

    const s = meter.snapshot();
    expect(s).toMatchObject({ deterministic: 3, model: 1, totalPlans: 4, modelBackedPlans: 1 });
    expect(s.zeroTokenRatio).toBe(0.75);
    expect(meter.describe()).toContain("zero-token 75%");
  });

  it("counts a remote fallback as free planning but not as a free call", () => {
    const meter = new PlanningMeter();
    meter.record(plan("remote"));
    meter.record(plan("local-fallback"));

    const s = meter.snapshot();
    // No tokens were spent on the plan that ran, so it is in the free share —
    // and it is a separate counter, because the round trip still cost latency.
    expect(s.zeroTokenRatio).toBe(0.5);
    expect(s).toMatchObject({ remote: 1, localFallback: 1, modelBackedPlans: 1 });
  });

  it("keeps chat turns out of the ratio and visible on their own", () => {
    const meter = new PlanningMeter();
    meter.record(plan("deterministic"));
    meter.recordChatTurn();
    meter.recordChatTurn();

    const s = meter.snapshot();
    // Conversation always costs a model call; there is no free path through it,
    // so folding it into a planning ratio would flatter the number.
    expect(s.zeroTokenRatio).toBe(1);
    expect(s.chatTurns).toBe(2);
  });

  it("does not pretend to know who produced an unattributed plan", () => {
    const meter = new PlanningMeter();
    meter.record(plan(undefined));
    expect(meter.snapshot()).toMatchObject({ unattributed: 1, zeroTokenRatio: 0 });
  });

  it("counts empty plans, because a plan that did nothing still cost what it cost", () => {
    const meter = new PlanningMeter();
    meter.record(plan("model", 0));
    expect(meter.snapshot()).toMatchObject({ emptyPlans: 1, model: 1 });
  });
});

describe("the agent counts its own planning", () => {
  const silent: LlmClient = {
    id: "silent",
    complete: async (): Promise<CompletionResult> => ({
      wantsToolCalls: false, message: { role: "assistant", content: "ok" },
    }),
  };

  it("records a deterministic plan as free", async () => {
    const agent = new Agent({ platform: createWebAdapter(), llm: silent, confirm: () => true });
    await agent.pursue({ id: "g", desiredState: [{ path: W.tvInput, equals: "hdmi2" }] });

    expect(agent.planning.snapshot()).toMatchObject({ deterministic: 1, modelBackedPlans: 0 });
    expect(agent.planning.snapshot().zeroTokenRatio).toBe(1);
  });

  it("records a chat turn as a model call", async () => {
    const agent = new Agent({ platform: createWebAdapter(), llm: silent });
    await agent.run("what's on tonight?");
    expect(agent.planning.snapshot()).toMatchObject({ chatTurns: 1, totalPlans: 0 });
  });

  it("attributes an injected planner's plans to it", async () => {
    const remote: Planner = { plan: async (goal) => ({ ...plan("remote"), goal }) };
    const agent = new Agent({
      platform: createWebAdapter(), llm: silent, confirm: () => true,
      llmPlanning: true, planner: remote,
    });
    await agent.pursue({ id: "g", intent: "do the thing", desiredState: [] });

    const s = agent.planning.snapshot();
    expect(s).toMatchObject({ remote: 1, deterministic: 0, modelBackedPlans: 1 });
    expect(s.zeroTokenRatio).toBe(0);
  });

  it("hands a planner factory the agent's own graph, not a copy", async () => {
    let seen: { sameGraph: boolean; sameWorld: boolean } | undefined;
    const agent = new Agent({
      platform: createWebAdapter(), llm: silent, confirm: () => true, llmPlanning: true,
      planner: (ctx) => {
        return {
          plan: async (goal) => {
            seen = {
              sameGraph: ctx.capabilities === agent.capabilities,
              sameWorld: ctx.world === agent.world,
            };
            return { ...plan("remote"), goal };
          },
        };
      },
    });
    await agent.pursue({ id: "g", intent: "do the thing", desiredState: [] });

    // The authoritative graph: the one the boot probe withdraws from. A copy
    // would keep proposing capabilities the agent had already given up on.
    expect(seen).toEqual({ sameGraph: true, sameWorld: true });
  });
});
