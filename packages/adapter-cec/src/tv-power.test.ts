import { describe, it, expect } from "vitest";
import {
  Agent, DeviceGraph, WorldModel, W, attachTransports, discoverRoom, summarizeOutcome, transportSources,
} from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createScriptedClient } from "@hearthkit/llm-connectors";
import { createCecTransport } from "./transport-binding.js";
import { cecTargets } from "./capabilities.js";
import { createMockCecBus, type MockCecDevice } from "./mock.js";

/**
 * A box *beside* the television: a Pi on one of its HDMI ports.
 *
 * The runtime used to assume the host was the TV and used CEC only for devices
 * past it, so on 2026-10-14 "turn off the tv" got "I can set volume, mute, switch
 * input, or open an app" while the bus — checked by hand a minute earlier — would
 * have put the set in standby and read that back. The television at address 0 is
 * a real device with its own power state; these are the four honest answers for
 * it, and the one where nothing is offered because nothing was asked to be.
 */

const TV = (over: Partial<MockCecDevice> = {}): MockCecDevice => ({
  logical: 0, physical: "0.0.0.0", osdName: "TV", vendorId: "Philips", power: "on", ...over,
});

async function room(tv: MockCecDevice, opts: { remoteTv?: boolean } = { remoteTv: true }) {
  const platform = createWebAdapter();
  await platform.init();
  const bus = createMockCecBus([tv]);
  const transports = [createCecTransport(bus, opts)];
  const devices = await discoverRoom(platform, { room: "empty", persist: false, sources: transportSources(transports) });
  const reach = await attachTransports(devices, transports);
  const agent = new Agent({
    platform, llm: createScriptedClient(), world: new WorldModel(), devices,
    capabilities: reach.capabilities, tools: reach.tools, confirm: async () => true,
  });
  return { agent, bus, reach, devices, tv };
}

const steps = (o: Awaited<ReturnType<Agent["pursueIntent"]>>) =>
  o?.outcomes.map((x) => `${x.step.action.capabilityId}:${x.status}`);

describe("the television as a CEC device, from a box beside it", () => {
  it("offers the TV's power, and says so at boot", async () => {
    const { reach } = await room(TV());
    expect(reach.capabilities.map((c) => c.id)).toEqual(expect.arrayContaining(["tv.power.on", "tv.power.off", "tv.power.status"]));
    expect(reach.notes[0]).toMatch(/1 device\(s\) reachable: tv/);
  });

  it("turns it off, and says verified only because the TV then reported standby", async () => {
    const { agent, bus } = await room(TV({ power: "on" }));
    const outcome = await agent.pursueIntent("turn off the tv");
    expect(steps(outcome)).toEqual(["tv.power.off:verified"]);
    expect(outcome?.achieved).toBe(true);
    expect(bus.sent).toContain("standby 0");
    expect(bus.sent.at(-1)).toBe("power_status 0");              // the read-back is the last thing that happened
    expect(agent.world.get(W.device("tv", "power"))?.source).toBe("tool");
    expect(bus.devices[0]!.power).toBe("standby");
  });

  it("wakes it with Image View On — not by asking the bus to show the TV at its own address", async () => {
    const { agent, bus } = await room(TV({ power: "standby" }));
    const outcome = await agent.pursueIntent("turn on the tv");
    expect(steps(outcome)).toEqual(["tv.power.on:verified"]);
    expect(bus.sent).toContain("image_view_on 0");
    expect(bus.sent.some((m) => m.startsWith("wake "))).toBe(false);
  });

  it("does nothing when the TV already is what was asked for", async () => {
    const { agent, bus } = await room(TV({ power: "on" }));
    const outcome = await agent.pursueIntent("turn on the tv");
    expect(outcome?.achieved).toBe(true);
    expect(bus.sent.some((m) => m.startsWith("image_view_on") || m.startsWith("standby"))).toBe(false);
  });

  it("understands it in Chinese too", async () => {
    const { agent, bus } = await room(TV({ power: "on" }));
    expect(steps(await agent.pursueIntent("關電視"))).toEqual(["tv.power.off:verified"]);
    expect(steps(await agent.pursueIntent("打開電視"))).toEqual(["tv.power.on:verified"]);
    expect(bus.sent.filter((m) => m === "standby 0" || m === "image_view_on 0")).toHaveLength(2);
  });

  it("says failed — not done — when the TV accepts standby and stays on", async () => {
    const { agent } = await room(TV({ power: "on", obeysStandby: false }));
    const outcome = await agent.pursueIntent("turn off the tv");
    expect(steps(outcome)).toEqual(["tv.power.off:failed"]);
    expect(outcome?.achieved).toBe(false);
    expect(summarizeOutcome(outcome!)).not.toMatch(/\bDone\b/);
  });

  it("says unverified when the TV never answers the power question", async () => {
    const { agent } = await room(TV({ power: "on", answersPowerStatus: false }));
    const outcome = await agent.pursueIntent("turn off the tv");
    expect(steps(outcome)).toEqual(["tv.power.off:unverified"]);
  });
});

describe("a host that IS the television is not offered itself", () => {
  it("adds no TV power capabilities without remoteTv — a Tizen set must not try to CEC-standby itself", async () => {
    const { reach } = await room(TV(), {});
    expect(reach.capabilities.map((c) => c.id)).not.toContain("tv.power.off");
    expect(reach.notes[0]).toMatch(/no reachable devices/);
  });

  it("adds none when the room has no tv node to attach the power to", () => {
    const graph = new DeviceGraph();
    expect(cecTargets(graph, [{ logical: 0, physical: "0.0.0.0" }], { remoteTv: true })).toEqual([]);
  });
});
