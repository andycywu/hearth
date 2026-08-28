import { describe, it, expect } from "vitest";
import {
  CapabilityGraph, GoalPlanner, PlanExecutor, PolicyEngine, ToolRegistry, WorldModel, W,
} from "@hearthkit/core";
import { createCecCapabilities, createCecTools } from "./capabilities.js";
import { createMockCecBus, type MockCecBus, type MockCecDevice } from "./mock.js";

/**
 * The four honest answers, produced by one plan against four buses.
 *
 * This is the whole argument of the project in a single file: the goal is the
 * same, the plan is the same, the code is the same, and the answer differs
 * because the *room* differs. A runtime that reported "done" for all four would
 * pass every test it had and be wrong three times.
 */

const PS5: MockCecDevice = {
  logical: 4, physical: "2.0.0.0", osdName: "PlayStation 5", power: "standby",
};

async function setup(device: MockCecDevice, opts: Parameters<typeof createMockCecBus>[1] = {}) {
  const bus: MockCecBus = createMockCecBus([device], opts);
  const world = new WorldModel();
  const graph = new CapabilityGraph();
  const tools = new ToolRegistry();

  graph.registerAll(createCecCapabilities("ps5"));
  for (const tool of await createCecTools(bus, [{ deviceId: "ps5", device }])) {
    tools.register(tool);
  }

  const planner = new GoalPlanner({ graph, world });
  const executor = new PlanExecutor({
    graph, world, tools,
    policy: new PolicyEngine(),
    confirm: async () => true,
  });
  return { bus, world, graph, tools, planner, executor };
}

const wakeGoal = { id: "ps5_on", desiredState: [{ path: W.device("ps5", "power"), equals: "on" }] };

describe("waking a console over CEC", () => {
  it("says verified when the console itself says it is on", async () => {
    const { bus, world, planner, executor } = await setup({ ...PS5 });

    const plan = await planner.plan(wakeGoal);
    expect(plan.steps.map((s) => s.action.capabilityId)).toEqual(["ps5.power.on"]);

    const outcome = await executor.run(plan);
    expect(outcome.outcomes[0]?.status).toBe("verified");
    expect(outcome.achieved).toBe(true);
    // The fact in the world is the console's answer, not ours.
    expect(world.get(W.device("ps5", "power"))?.source).toBe("tool");
    expect(world.value(W.device("ps5", "power"))).toBe("on");
    // And it was asked, rather than assumed: `<Set Stream Path>` then
    // `<Give Device Power Status>`.
    expect(bus.sent).toEqual(["wake 2.0.0.0", "power_status 4"]);
  });

  it("says unverified when the console wakes but never answers the question", async () => {
    // Very common hardware behaviour, and the case that made this whole file
    // necessary: the device is on, and nothing on the bus will confirm it.
    const { world, planner, executor } = await setup({ ...PS5, answersPowerStatus: false });

    const outcome = await executor.run(await planner.plan(wakeGoal));
    expect(outcome.outcomes[0]?.status).toBe("unverified");
    // The world keeps our assumption, at assumption confidence, labelled as one.
    // That is a prior worth having and it is not evidence.
    expect(world.get(W.device("ps5", "power"))?.source).toBe("assumed");
  });

  it("says failed when the bus accepted the message and the console stayed asleep", async () => {
    // Accepted and not performed — the exact failure this runtime exists to
    // refuse to call success.
    const { bus, world, planner, executor } = await setup({ ...PS5, wakesOnStreamPath: false });

    const outcome = await executor.run(await planner.plan(wakeGoal));
    expect(outcome.outcomes[0]?.status).toBe("failed");
    expect(outcome.achieved).toBe(false);
    expect(world.value(W.device("ps5", "power"))).toBe("standby");
    expect(bus.sent).toContain("power_status 4");
  });

  it("says unsupported once, and stops offering it, when there is no CEC at all", async () => {
    const { graph, tools, planner, executor } = await setup({ ...PS5 }, { absent: true });

    // No transport, so no tools are projected — the model is never shown a
    // button that cannot work. The capability still exists in the graph, so the
    // planner can say what it *would* have done.
    expect(tools.list()).toHaveLength(0);
    const plan = await planner.plan(wakeGoal);
    expect(plan.steps.map((s) => s.action.capabilityId)).toEqual(["ps5.power.on"]);

    const outcome = await executor.run(plan);
    expect(outcome.outcomes[0]?.status).toBe("unsupported");
    expect(graph.get("ps5.power.on")?.status).toBe("withdrawn");
  });

  it("does not report a device mid-transition as awake", async () => {
    // `<Report Power Status>` 0x02 means "on its way". Reporting the state it is
    // heading for is the same optimism the read-back exists to prevent.
    const { world, planner, executor } = await setup({ ...PS5, power: "to_on", wakesOnStreamPath: false });

    const outcome = await executor.run(await planner.plan(wakeGoal));
    expect(outcome.outcomes[0]?.status).toBe("unverified");
    expect(world.get(W.device("ps5", "power"))?.source).toBe("assumed");
  });

  it("refuses to wake a device that never reported a physical address", async () => {
    // `<Set Stream Path>` is addressed by physical address. Without one there is
    // no message to send, which is absence rather than failure — so it is
    // withdrawn instead of retried.
    const { graph, planner, executor } = await setup({ logical: 4, osdName: "Mystery box", power: "standby" });

    const outcome = await executor.run(await planner.plan(wakeGoal));
    expect(outcome.outcomes[0]?.status).toBe("unsupported");
    expect(graph.get("ps5.power.on")?.status).toBe("withdrawn");
  });
});

describe("standby", () => {
  it("verifies against the console's own answer", async () => {
    const { bus, world, planner, executor } = await setup({ ...PS5, power: "on" });

    const outcome = await executor.run(await planner.plan({
      id: "ps5_off",
      desiredState: [{ path: W.device("ps5", "power"), equals: "standby" }],
    }));

    expect(outcome.outcomes[0]?.status).toBe("verified");
    expect(world.value(W.device("ps5", "power"))).toBe("standby");
    expect(bus.sent).toEqual(["standby 4", "power_status 4"]);
  });

  it("needs confirming, because turning someone's console off is not a low-risk act", async () => {
    const device: MockCecDevice = { ...PS5, power: "on" };
    const bus = createMockCecBus([device]);
    const world = new WorldModel();
    const graph = new CapabilityGraph();
    const tools = new ToolRegistry();
    graph.registerAll(createCecCapabilities("ps5"));
    for (const tool of await createCecTools(bus, [{ deviceId: "ps5", device }])) tools.register(tool);

    const asked: string[] = [];
    const executor = new PlanExecutor({
      graph, world, tools,
      policy: new PolicyEngine(),
      confirm: async (req) => { asked.push(req.capability.id); return false; },
    });

    const plan = await new GoalPlanner({ graph, world }).plan({
      id: "ps5_off",
      desiredState: [{ path: W.device("ps5", "power"), equals: "standby" }],
    });
    const outcome = await executor.run(plan);

    expect(asked).toEqual(["ps5.power.off"]);
    expect(outcome.outcomes[0]?.status).toBe("denied");
    // Declined means nothing was sent, not "sent and then apologised for".
    expect(bus.sent).toEqual([]);
    expect(device.power).toBe("on");
  });
});

describe("two devices on one bus", () => {
  it("registers a distinct tool per device", async () => {
    // Core names a power tool after its *provider*, so two CEC devices both
    // wanted to be `cec_power_on` — and the registry throws on a duplicate, so
    // this was a boot crash in any living room with a console and a set-top box.
    const devices: MockCecDevice[] = [
      { logical: 4, physical: "2.0.0.0", osdName: "PlayStation 5" },
      { logical: 3, physical: "1.0.0.0", osdName: "Set-top box" },
    ];
    const bus = createMockCecBus(devices);
    const tools = new ToolRegistry();

    const projected = await createCecTools(bus, [
      { deviceId: "ps5", device: devices[0]! },
      { deviceId: "stb", device: devices[1]! },
    ]);
    for (const tool of projected) tools.register(tool);

    expect(tools.list().map((t) => t.name).sort()).toEqual([
      "cec_power_off_ps5", "cec_power_off_stb",
      "cec_power_on_ps5", "cec_power_on_stb",
      "cec_power_status_ps5", "cec_power_status_stb",
    ]);
  });
});
