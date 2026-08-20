import { describe, it, expect, beforeEach } from "vitest";
import { createWebAdapter } from "@hearthkit/adapter-web";
import type { PlatformProvider } from "@hearthkit/platform-api";
import { CapabilityGraph } from "../capabilities/graph.js";
import {
  createTvCapabilities, createMediaCapabilities, createDevicePowerCapabilities,
} from "../capabilities/tv-capabilities.js";
import { DeviceGraph, createManualSource, runDiscovery } from "../devices/graph.js";
import { PolicyEngine } from "../policy/policy.js";
import { ToolRegistry } from "../tools/registry.js";
import { createTvTools } from "../tools/tv-tools.js";
import { tvOk } from "../tools/result.js";
import { WorldModel } from "../world/model.js";
import { observeResult } from "../world/from-tools.js";
import { W } from "../world/state.js";
import { GoalPlanner } from "./planner.js";
import { PlanExecutor } from "./executor.js";
import { SKILLS, resolveDeviceParams } from "../skills/scenarios.js";

/**
 * The four P0 scenarios, end to end: goal -> world -> capability graph -> plan ->
 * policy -> execute -> verify -> world.
 *
 * What each one is really asserting is that the agent did *not* command-map. The
 * PS5 case is the sharpest: the string "hdmi2" is never written in the goal, the
 * skill or the planner — it is looked up from the Device Graph — so moving the
 * console to another port changes the plan and changes no code.
 */

const skill = (id: string) => SKILLS.find((s) => s.id === id)!;

function setup() {
  const platform: PlatformProvider = createWebAdapter();
  const world = new WorldModel();
  const graph = new CapabilityGraph();
  const devices = new DeviceGraph();
  const tools = new ToolRegistry();

  for (const tool of createTvTools(platform)) tools.register(tool);
  graph.registerAll(createTvCapabilities("adapter:web"));
  graph.registerAll(createMediaCapabilities("adapter:web"));

  // A CEC transport that reports success but offers nothing to read back — the
  // common real-world case, and the reason `unverified` has to be a distinct
  // outcome from `verified`.
  let cecCalls = 0;
  tools.register({
    spec: { name: "cec_power_on", description: "Wake a device over HDMI-CEC.", parameters: {} },
    execute: async () => { cecCalls++; return tvOk(); },
  });
  graph.registerAll(createDevicePowerCapabilities("ps5", "cec"));

  const planner = new GoalPlanner({ graph, world });
  const asked: string[] = [];
  const executor = new PlanExecutor({
    graph, world, tools,
    policy: new PolicyEngine(),
    confirm: async (req) => { asked.push(req.capability.id); return true; },
  });

  return { platform, world, graph, devices, tools, planner, executor, asked, cec: () => cecCalls };
}

describe("Scenario A — 切到 HDMI2", () => {
  it("switches the input and verifies it with a read-back", async () => {
    const { world, planner, executor, graph } = setup();

    const plan = await planner.plan({
      id: "input_switched",
      desiredState: [{ path: W.tvInput, equals: "hdmi2" }],
    });
    expect(plan.steps.map((s) => s.action.capabilityId)).toEqual(["tv.input.switch"]);

    const outcome = await executor.run(plan);
    expect(outcome.outcomes[0]?.status).toBe("verified");
    expect(outcome.achieved).toBe(true);
    expect(world.value(W.tvInput)).toBe("hdmi2");
    // Verified once, so the capability stops being a claim and becomes a fact
    // about this device.
    expect(graph.get("tv.input.switch")?.status).toBe("available");
  });

  it("does nothing when the TV is already there", async () => {
    const { world, planner, executor } = setup();
    world.observe({ path: W.tvInput, value: "hdmi2", source: "tool" });
    const plan = await planner.plan({
      id: "input_switched",
      desiredState: [{ path: W.tvInput, equals: "hdmi2" }],
    });
    expect(plan.steps).toHaveLength(0);
    expect((await executor.run(plan)).achieved).toBe(true);
  });
});

describe("Scenario B — 我要打 PS5", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    ctx = setup();
    await runDiscovery(ctx.devices, [createManualSource([
      { id: "tv", type: "tv", name: "Living Room TV", connection: { kind: "internal" }, source: "manual" },
      { id: "ps5", type: "game_console", name: "PlayStation 5", connection: { kind: "hdmi", port: "hdmi2" }, source: "manual" },
      { id: "stb", type: "stb", name: "Set-top box", connection: { kind: "hdmi", port: "hdmi3" }, source: "manual" },
    ])]);
  });

  it("plans a goal, not a command — the port comes from the device graph", async () => {
    const { devices, planner, executor, world } = ctx;

    const params = resolveDeviceParams(devices, "playstation");
    expect(params).toEqual({ device: "ps5", port: "hdmi2" });

    const plan = await planner.plan(skill("gaming_session").goal(params!));
    expect(plan.steps.map((s) => s.action.capabilityId)).toEqual(["ps5.power.on", "tv.input.switch"]);
    // Derived, never written down.
    expect(plan.steps[1]?.action.args).toEqual({ source: "hdmi2" });

    const outcome = await executor.run(plan);
    expect(ctx.cec()).toBe(1);
    expect(outcome.outcomes.map((o) => o.status)).toEqual(["unverified", "verified"]);
    expect(outcome.achieved).toBe(true);
    expect(world.value(W.tvInput)).toBe("hdmi2");
  });

  it("follows the console to another port with no code change", async () => {
    const { devices, planner } = ctx;
    devices.observe({ id: "ps5", connection: { kind: "hdmi", port: "hdmi4" }, source: "manual", confidence: 1 });

    const params = resolveDeviceParams(devices, "ps5")!;
    const plan = await planner.plan(skill("gaming_session").goal(params));
    expect(plan.steps.at(-1)?.action.args).toEqual({ source: "hdmi4" });
  });

  it("drops the optional steps this TV cannot do, and says which goal it missed", async () => {
    const { devices, planner } = ctx;
    const plan = await planner.plan(skill("gaming_session").goal(resolveDeviceParams(devices, "ps5")!));
    // No picture-mode capability on this adapter: the optional predicates are
    // dropped rather than failing the plan, and nothing is reported unreachable
    // because nothing required was.
    expect(plan.steps.some((s) => s.action.capabilityId.includes("picture"))).toBe(false);
    expect(plan.unreachable).toBeUndefined();
  });
});

describe("Scenario C — 我要看電影", () => {
  it("reaches playback through a capability, with the content layer as a tool", async () => {
    const { planner, executor, world } = setup();
    const plan = await planner.plan(skill("movie_night").goal({}));
    expect(plan.steps.map((s) => s.action.capabilityId)).toEqual(["content.resume"]);

    const outcome = await executor.run(plan);
    // No playback-state read in the HAL, so the honest answer is `unverified` —
    // not `verified`, which would be a claim we cannot back.
    expect(outcome.outcomes[0]?.status).toBe("unverified");
    expect(world.get(W.contentState)?.source).toBe("assumed");
  });
});

describe("Scenario D — 小聲一點", () => {
  it("resolves a relative intent against world state rather than re-reading", async () => {
    const { graph, tools, world, planner, executor } = setup();

    // One read, at the start of the session.
    const getVolume = graph.get("tv.audio.get_volume")!;
    observeResult(world, getVolume, await tools.call("get_volume", {}));
    expect(world.value(W.tvVolume)).toBe(20);

    const level = Number(world.value(W.tvVolume)) - 10;
    const plan = await planner.plan(skill("quieter").goal({ level }));
    expect(plan.steps[0]?.action).toEqual({ capabilityId: "tv.audio.set_volume", args: { level: 10 } });

    const outcome = await executor.run(plan);
    expect(outcome.outcomes[0]?.status).toBe("verified");
    expect(world.value(W.tvVolume)).toBe(10);
  });
});

describe("policy", () => {
  it("asks before a medium-risk step and abandons the plan when declined", async () => {
    const { graph, world, tools } = setup();
    const executor = new PlanExecutor({
      graph, world, tools,
      policy: new PolicyEngine(),
      confirm: async () => false,
    });
    const plan = {
      id: "p", createdAt: 0,
      goal: { id: "g", desiredState: [{ path: W.tvForegroundApp, equals: "com.netflix.ninja" }] },
      steps: [{
        id: "s1",
        action: { capabilityId: "tv.app.launch", args: { appId: "com.netflix.ninja" } },
        preconditions: [],
        expectedResult: [{ path: W.tvForegroundApp, set: "com.netflix.ninja" }],
      }],
    };
    const outcome = await executor.run(plan);
    expect(outcome.outcomes[0]?.status).toBe("denied");
    expect(outcome.achieved).toBe(false);
    expect(world.known(W.tvForegroundApp)).toBe(false); // nothing was assumed
  });

  it("never lets an unknown capability run", async () => {
    const { graph, world, tools } = setup();
    const executor = new PlanExecutor({ graph, world, tools, policy: new PolicyEngine() });
    const outcome = await executor.run({
      id: "p", createdAt: 0,
      goal: { id: "g", desiredState: [] },
      steps: [{ id: "s", action: { capabilityId: "door.unlock", args: {} }, preconditions: [], expectedResult: [] }],
    });
    expect(outcome.outcomes[0]?.status).toBe("failed");
  });
});
