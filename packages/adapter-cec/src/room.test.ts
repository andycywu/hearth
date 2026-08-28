import { describe, it, expect } from "vitest";
import {
  CapabilityGraph, DeviceGraph, DEMO_ROOM, GoalPlanner, WorldModel, W,
  createManualSource, createTvCapabilities, findSkill, runDiscovery,
} from "@hearthkit/core";
import { createCecSource } from "./source.js";
import { cecTargets, createCecCapabilities } from "./capabilities.js";
import { createMockCecBus, MOCK_LIVING_ROOM } from "./mock.js";

/**
 * What happens when CEC arrives in a room that already believes something.
 *
 * This is the join the whole package hangs on and the easiest thing to get
 * subtly wrong: CEC knows a console as `2.0.0.0`, a person knows it as "the
 * PS5", and a skill resolving 「我要打 PS5」 looks for the latter. Capabilities
 * registered under the CEC address would produce a plan for a device the goal
 * has never heard of — every step correct, the whole thing useless.
 */

async function room() {
  const devices = new DeviceGraph();
  const bus = createMockCecBus(MOCK_LIVING_ROOM);
  await runDiscovery(devices, [
    // The demo living room: someone registered a console on HDMI2.
    createManualSource(DEMO_ROOM),
    createCecSource(bus),
  ]);
  return { devices, bus };
}

describe("CEC meeting a room that already exists", () => {
  it("attaches capabilities to the node the user's words resolve to", async () => {
    const { devices, bus } = await room();
    const targets = cecTargets(devices, await bus.scan());

    // The hand-registered `ps5` and the CEC device at 2.0.0.0 are one node, and
    // its id is `ps5` — which is what `devices.find("ps5")` answers with.
    expect(targets.map((t) => t.deviceId)).toContain("ps5");
    expect(targets.map((t) => t.deviceId)).not.toContain("cec-2-0-0-0");
    expect(devices.get("ps5")?.cecAddress).toBe("2.0.0.0");
    expect(devices.get("ps5")?.discoveredBy).toEqual(expect.arrayContaining(["manual", "hdmi_cec"]));
  });

  it("brings in a device nobody had registered, and folds one into what was", async () => {
    const { devices, bus } = await room();
    const targets = cecTargets(devices, await bus.scan());

    // Two different outcomes on one port, and both are right:
    //
    //  - Nothing was registered at 3.1.0.0, so the box behind the AVR arrives as
    //    a new node, with the hop intact.
    //  - Something *was* registered on HDMI3 — the demo room's set-top box — and
    //    it has no CEC address, so the AVR that answered from 3.0.0.0 folds into
    //    it rather than appearing beside it. A person who typed a device in
    //    outranks a bus on the fields they claimed; CEC still contributes the
    //    address, which is what makes the node addressable at all.
    expect(targets.map((t) => t.deviceId)).toContain("cec-3-1-0-0");
    expect(devices.get("stb")?.cecAddress).toBe("3.0.0.0");
    expect(devices.get("stb")?.name).toBe("Set-top box");
    expect(devices.get("cec-3-1-0-0")?.parentId).toBe("stb");
    // The alternative — a new node per CEC device — would duplicate every
    // hand-registered device in the room the moment a bus appeared.
    expect(devices.list().map((d) => d.id)).not.toContain("cec-3-0-0-0");
  });

  it("offers nothing for a device the bus cannot reach", async () => {
    const { devices, bus } = await room();
    // The demo room's set-top box on HDMI3 is not on the CEC bus… but the AVR
    // is, on the same port, so the graph merged them: one node, one address.
    // What must not happen is a target for a node with no CEC address at all.
    const targets = cecTargets(devices, await bus.scan());
    for (const target of targets) {
      expect(devices.get(target.deviceId)?.cecAddress).toBeDefined();
    }
  });

  it("plans 我要打 PS5 across the TV and the console, with the port looked up", async () => {
    const { devices, bus } = await room();
    const targets = cecTargets(devices, await bus.scan());

    const graph = new CapabilityGraph();
    graph.registerAll(createTvCapabilities("adapter:web"));
    for (const target of targets) graph.registerAll(createCecCapabilities(target.deviceId));

    const skill = findSkill("gaming_session")!;
    const params = await skill.resolve!({}, { devices, world: new WorldModel() } as never);
    expect(params).toBeDefined();

    const plan = await new GoalPlanner({ graph, world: new WorldModel() }).plan(skill.goal(params!));

    // The console is woken over CEC and the TV is switched to the port the
    // *graph* says it is on. "hdmi2" is written nowhere in the goal or the
    // skill — move the console and the plan moves with it.
    expect(plan.steps.map((s) => s.action.capabilityId)).toEqual(
      expect.arrayContaining(["ps5.power.on", "tv.input.switch"]),
    );
    const input = plan.steps.find((s) => s.action.capabilityId === "tv.input.switch");
    expect(input?.action.args.source).toBe("hdmi2");
    // And nothing is out of reach: before CEC, waking the console was a
    // capability with no transport behind it.
    expect(plan.unreachable ?? []).toHaveLength(0);
    expect(plan.steps.some((s) => s.verification?.kind === "read_back"
      && s.verification.predicate.path === W.device("ps5", "power"))).toBe(true);
  });
});
