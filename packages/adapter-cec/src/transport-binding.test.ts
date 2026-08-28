import { describe, it, expect } from "vitest";
import {
  Agent, DeviceGraph, DEMO_ROOM, WorldModel, W,
  attachTransports, createManualSource, discoverRoom, runDiscovery, summarizeOutcome, transportSources,
} from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createScriptedClient } from "@hearthkit/llm-connectors";
import { createCecTransport } from "./transport-binding.js";
import { createMockCecBus, MOCK_LIVING_ROOM, type MockCecDevice } from "./mock.js";

/**
 * The two calls a host makes, and what a television gets for them.
 *
 * This is the same path `@hearthkit/host` runs at boot and the dev harness runs
 * behind `?cec=mock` — deliberately, because the reason the boot sequence was
 * consolidated in the first place is that three copies of it had drifted into
 * three different behaviours.
 */

/** The mock room, with the AVR that never answers the power question. */
const ROOM: MockCecDevice[] = MOCK_LIVING_ROOM.map((d) => (
  d.logical === 5 ? { ...d, answersPowerStatus: false } : { ...d }
));

describe("a CEC bus, wired the way a host wires it", () => {
  it("contributes a room and then capabilities for what was found in it", async () => {
    const transports = [createCecTransport(createMockCecBus(ROOM))];

    const devices = new DeviceGraph();
    await runDiscovery(devices, [createManualSource(DEMO_ROOM), ...transportSources(transports)]);
    const reach = await attachTransports(devices, transports);

    expect(reach.capabilities.map((c) => c.id)).toEqual(expect.arrayContaining([
      "ps5.power.on", "ps5.power.off", "ps5.power.status",
    ]));
    // A tool per capability that has a handler, named per device so two consoles
    // cannot collide.
    expect(reach.tools.map((t) => t.spec.name)).toEqual(expect.arrayContaining([
      "cec_power_on_ps5", "cec_power_status_ps5",
    ]));
    expect(reach.notes[0]).toMatch(/^cec: 3 device\(s\) reachable/);
    expect(reach.failed).toHaveLength(0);
  });

  it("registers nothing, and does not fail, where there is no bus", async () => {
    // The normal case: Android without the HDMI_CEC permission, and every Tizen
    // and webOS build there is. A television must boot exactly as before.
    const transports = [createCecTransport(createMockCecBus(ROOM, { absent: true }))];

    const devices = new DeviceGraph();
    await runDiscovery(devices, [createManualSource(DEMO_ROOM), ...transportSources(transports)]);
    const reach = await attachTransports(devices, transports);

    expect(reach.capabilities).toHaveLength(0);
    expect(reach.tools).toHaveLength(0);
    expect(reach.failed).toHaveLength(0);
    expect(reach.notes).toEqual(["cec: no bus on this platform"]);
    // The room is still the room — the hand-registered console did not vanish
    // because a transport was missing.
    expect(devices.get("ps5")?.name).toBe("PlayStation 5");
  });

  it("says so rather than throwing when the bus is there and broken", async () => {
    const transports = [createCecTransport(createMockCecBus(ROOM, { scanFails: true }))];
    const devices = new DeviceGraph();
    const reach = await attachTransports(devices, transports);

    expect(reach.failed).toEqual(["cec"]);
    expect(reach.notes[0]).toMatch(/unavailable/);
  });

  it("reports an empty bus as empty, not as absent", async () => {
    // An HDMI port with nothing in it, or devices that do not speak CEC. Both
    // are unremarkable, and neither is "this platform has no CEC" — which is the
    // one that gets a capability withdrawn for good.
    const reach = await attachTransports(new DeviceGraph(), [createCecTransport(createMockCecBus([]))]);
    expect(reach.notes).toEqual(["cec: bus present, no reachable devices"]);
  });

  it("gets a television from a goal to a woken console", async () => {
    const platform = createWebAdapter();
    await platform.init();
    const transports = [createCecTransport(createMockCecBus(ROOM))];

    const devices = await discoverRoom(platform, {
      room: "demo", persist: false, sources: transportSources(transports),
    });
    const reach = await attachTransports(devices, transports);

    const agent = new Agent({
      platform, llm: createScriptedClient(), world: new WorldModel(), devices,
      capabilities: reach.capabilities, tools: reach.tools,
      confirm: async () => true,
    });

    const outcome = await agent.pursueIntent("我要打 PS5");
    expect(outcome?.outcomes.map((o) => `${o.step.action.capabilityId}:${o.status}`)).toEqual([
      "ps5.power.on:verified",
      "tv.input.switch:verified",
    ]);
    expect(outcome?.achieved).toBe(true);
    // The console's own answer, not ours.
    expect(agent.world.get(W.device("ps5", "power"))?.source).toBe("tool");
  });

  it("says unverified for the device that will not answer", async () => {
    const platform = createWebAdapter();
    await platform.init();
    const transports = [createCecTransport(createMockCecBus(ROOM))];
    const devices = await discoverRoom(platform, {
      room: "demo", persist: false, sources: transportSources(transports),
    });
    const reach = await attachTransports(devices, transports);
    const agent = new Agent({
      platform, llm: createScriptedClient(), world: new WorldModel(), devices,
      capabilities: reach.capabilities, tools: reach.tools,
      confirm: async () => true,
    });

    // `stb` is the node the AVR merged into, and that AVR never replies to
    // `<Give Device Power Status>` — so the runtime has to say it cannot tell,
    // and say it about the right device.
    const outcome = await agent.pursue({
      id: "stb_on",
      desiredState: [{ path: W.device("stb", "power"), equals: "on" }],
    });

    expect(outcome.outcomes[0]?.status).toBe("unverified");
    expect(summarizeOutcome(outcome)).toContain("Asked the stb to");
  });
});
