import { describe, it, expect } from "vitest";
import { CapabilityGraph } from "../capabilities/graph.js";
import { createTvCapabilities, createDevicePowerCapabilities } from "../capabilities/tv-capabilities.js";
import { PolicyEngine, defaultRules, parentalRules } from "../policy/policy.js";
import { WorldModel } from "../world/model.js";
import { W } from "../world/state.js";
import { createLlmPlanner, parseSteps } from "./llm-planner.js";
import type { LlmClient, CompletionResult } from "../llm/client.js";
import type { Plan } from "./types.js";

/** An LLM that says exactly what the test wants it to say. */
function saying(content: string): LlmClient & { prompt: () => string } {
  let prompt = "";
  return {
    id: "canned",
    prompt: () => prompt,
    complete: async (req): Promise<CompletionResult> => {
      prompt = req.messages.map((m) => m.content).join("\n---\n");
      return { wantsToolCalls: false, message: { role: "assistant", content } };
    },
  };
}

function setup(content: string, opts: { policy?: PolicyEngine; world?: WorldModel } = {}) {
  const graph = new CapabilityGraph();
  graph.registerAll(createTvCapabilities("adapter:web"));
  graph.registerAll(createDevicePowerCapabilities("ps5", "cec"));
  const world = opts.world ?? new WorldModel();
  const llm = saying(content);
  const planner = createLlmPlanner({
    llm, graph, world,
    ...(opts.policy ? { policy: opts.policy } : {}),
    now: () => 1,
  });
  return { planner, graph, world, llm };
}

const goal = { id: "freeform", intent: "switch to hdmi2", desiredState: [] };
const ids = (plan: Plan) => plan.steps.map((s) => s.action.capabilityId);
const why = (plan: Plan) => (plan.rejections ?? []).map((r) => r.reason).join(" | ");

describe("LLM planner — what it accepts", () => {
  it("turns a proposal into a plan whose checks came from the graph, not the model", async () => {
    const { planner } = setup('{"steps":[{"capability":"tv.input.switch","args":{"source":"hdmi2"}}]}');
    const plan = await planner.plan(goal);
    expect(ids(plan)).toEqual(["tv.input.switch"]);
    // The model wrote neither of these, and could not have weakened them.
    expect(plan.steps[0]?.verification).toMatchObject({ kind: "read_back", capability: "tv.input.get_source" });
    expect(plan.steps[0]?.expectedResult).toEqual([{ path: W.tvInput, set: "hdmi2" }]);
  });

  it("survives a fenced, chatty answer", async () => {
    const { planner } = setup(
      'Sure! Here you go:\n```json\n{"steps":[{"capability":"tv.audio.set_mute","args":{"mute":true}}]}\n```',
    );
    expect(ids(await planner.plan(goal))).toEqual(["tv.audio.set_mute"]);
  });

  it("accepts a bare array, because models return one", async () => {
    const { planner } = setup('[{"capability":"tv.audio.set_volume","args":{"level":30}}]');
    expect(ids(await planner.plan(goal))).toEqual(["tv.audio.set_volume"]);
  });

  it("coerces arguments the same way the tool layer would", async () => {
    const { planner } = setup('{"steps":[{"capability":"tv.audio.set_volume","args":{"level":"30"}}]}');
    const plan = await planner.plan(goal);
    expect(plan.steps[0]?.action.args).toEqual({ level: 30 });
  });

  it("judges each precondition against the state the previous step leaves", async () => {
    const world = new WorldModel();
    world.observe({ path: W.tvPower, value: "off", source: "tool" });
    const { planner } = setup(JSON.stringify({
      steps: [
        { capability: "ps5.power.on" },
        { capability: "tv.input.switch", args: { source: "hdmi2" } },
      ],
    }), { world });
    const plan = await planner.plan(goal);
    // Switching input needs the TV not to be off, and nothing in this plan turns
    // it on — so that step goes, while the console step, which needs nothing,
    // stays.
    expect(ids(plan)).toEqual(["ps5.power.on"]);
    expect(why(plan)).toMatch(/needs tv\.power to be different/);
  });

  it("tells the model what it is working with", async () => {
    const world = new WorldModel();
    world.observe({ path: W.tvVolume, value: 35, source: "tool" });
    const { planner, llm } = setup('{"steps":[]}', { world });
    await planner.plan({ id: "quieter", intent: "make it quieter", desiredState: [{ path: W.tvVolume, lte: 20 }] });
    expect(llm.prompt()).toContain("tv.audio.set_volume(level:number)");
    expect(llm.prompt()).toContain("tv.volume: 35");
    expect(llm.prompt()).toContain("tv.volume <= 20");
  });
});

describe("LLM planner — what it throws out, before anything runs", () => {
  it("a capability that does not exist", async () => {
    const { planner } = setup('{"steps":[{"capability":"tv.display.enable_game_mode","args":{}}]}');
    const plan = await planner.plan(goal);
    expect(plan.steps).toEqual([]);
    expect(why(plan)).toMatch(/no such capability on this device/);
  });

  it("a capability this device withdrew", async () => {
    const { planner, graph } = setup('{"steps":[{"capability":"tv.audio.set_volume","args":{"level":30}}]}');
    graph.withdraw("tv.audio.set_volume", "no audio API on this build");
    const plan = await planner.plan(goal);
    expect(plan.steps).toEqual([]);
    expect(why(plan)).toMatch(/withdrawn/);
  });

  it("an argument outside the schema's enum", async () => {
    const { planner } = setup('{"steps":[{"capability":"tv.input.switch","args":{"source":"hdmi9"}}]}');
    const plan = await planner.plan(goal);
    expect(plan.steps).toEqual([]);
    expect(why(plan)).toMatch(/must be one of/);
  });

  it("a missing required argument", async () => {
    const { planner } = setup('{"steps":[{"capability":"tv.input.switch","args":{}}]}');
    expect(why(await planner.plan(goal))).toMatch(/missing required "source"|missing a required argument/);
  });

  it("a step policy denies outright", async () => {
    const policy = new PolicyEngine([...defaultRules(), ...parentalRules({ maxVolume: 30 })]);
    const { planner } = setup('{"steps":[{"capability":"tv.audio.set_volume","args":{"level":90}}]}', { policy });
    const plan = await planner.plan(goal);
    expect(plan.steps).toEqual([]);
    expect(why(plan)).toMatch(/capped at 30/);
  });

  it("more steps than the cap allows", async () => {
    const steps = Array.from({ length: 12 }, () => ({ capability: "tv.audio.set_mute", args: { mute: true } }));
    const { planner } = setup(JSON.stringify({ steps }));
    const plan = await planner.plan(goal);
    expect(plan.steps.length).toBeLessThanOrEqual(8);
    expect(why(plan)).toMatch(/more than 8 steps/);
  });

  it("prose, an apology, or anything else that is not a plan", async () => {
    for (const answer of ["I'm sorry, I can't help with that.", "", "{", '{"steps":"soon"}']) {
      const { planner } = setup(answer);
      // No steps is a plan that does nothing, which is the safe way to fail.
      expect((await planner.plan(goal)).steps).toEqual([]);
    }
  });

  it("records what it rejected, so nobody has to guess", async () => {
    const { planner } = setup('{"steps":[{"capability":"door.unlock","args":{"code":"1234"}}]}');
    const plan = await planner.plan(goal);
    expect(plan.rejections).toEqual([
      { capabilityId: "door.unlock", args: { code: "1234" }, reason: "no such capability on this device: door.unlock" },
    ]);
  });
});

describe("parseSteps", () => {
  it("finds the plan inside whatever wrapping arrived", () => {
    expect(parseSteps('```json\n{"steps":[{"capability":"a"}]}\n```')).toHaveLength(1);
    expect(parseSteps('here: [{"capability":"a"}] hope that helps')).toHaveLength(1);
    expect(parseSteps("no json at all")).toEqual([]);
    expect(parseSteps('{"steps":[null,"x",{"capability":"a"}]}')).toHaveLength(1);
  });
});
