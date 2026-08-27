import { describe, it, expect } from "vitest";
import {
  CapabilityGraph, DeviceGraph, WorldModel, W, applyPerception,
  createTvCapabilities, createMediaCapabilities,
} from "@hearthkit/core";
import { buildTaskRequest, minimiseRoomState, REQUIRED_KEYS } from "./task-mapper.js";

/**
 * The mapper is the boundary where a household's living room could leak, so
 * these tests are mostly about what is *absent* from the request.
 */

function room() {
  const world = new WorldModel();
  world.observe({ path: W.tvPower, value: "on", source: "tool" });
  world.observe({ path: W.tvInput, value: "hdmi1", source: "tool" });
  world.observe({ path: W.tvVolume, value: 35, source: "tool" });
  world.observe({ path: W.tvMuted, value: false, source: "tool" });
  world.observe({ path: W.contentState, value: "playing", source: "assumed" });

  const devices = new DeviceGraph();
  devices.observe({
    id: "ps5", name: "PlayStation 5", type: "game_console", vendor: "Sony",
    model: "CFI-1216A", connection: { kind: "hdmi", port: "hdmi2" },
    source: "manual", confidence: 1,
  });
  devices.observe({
    id: "appletv", name: "Andy's Apple TV", type: "streaming_stick",
    connection: { kind: "network", ip: "10.0.0.5", mac: "aa:bb:cc:dd:ee:ff" },
    source: "mdns", confidence: 0.8,
  });

  const capabilities = new CapabilityGraph();
  capabilities.registerAll(createTvCapabilities("adapter:web"));
  capabilities.registerAll(createMediaCapabilities("adapter:web"));
  return { world, devices, capabilities };
}

const goal = {
  id: "input_switched",
  intent: "put the PlayStation on",
  desiredState: [{ path: W.tvInput, equals: "hdmi2" }],
};

describe("TaskRequest mapping", () => {
  it("carries the shape ModelPilot expects", () => {
    const { world, devices, capabilities } = room();
    const req = buildTaskRequest({ goal, world, devices, capabilities });

    expect(req.strategy).toBe("plan_execute_verify");
    expect(req.requirements.intelligence).toBe("reasoning");
    expect(req.requirements.capabilities).toEqual(["planning", "tv_control"]);
    expect(req.requirements.approvalMode).toBe("high_risk");
    expect(req.verification).toEqual({ type: "json_schema", requiredKeys: [...REQUIRED_KEYS] });
    expect(req.economics).toEqual({ maxTaskBudget: 0.05, currency: "USD" });
  });

  it("maps the confidential + zero-retention policy exactly", () => {
    const { world, devices, capabilities } = room();
    const req = buildTaskRequest({ goal, world, devices, capabilities });

    expect(req.requirements.privacy).toBe("no_training");
    expect(req.requirements.dataPolicy).toEqual({
      sensitivity: "confidential",
      retentionRequirement: "zero",
      trainingUse: "prohibited",
      // The engine may reason; it may not reach anything in this house.
      toolEgress: "denied",
      humanReview: "allowed",
    });
  });

  it("honours the caller's budget and latency ceilings", () => {
    const { world, devices, capabilities } = room();
    const req = buildTaskRequest({
      goal, world, devices, capabilities, maxTaskBudget: 0.01, maxLatencyMs: 2000,
    });
    expect(req.economics.maxTaskBudget).toBe(0.01);
    expect(req.requirements.maxCost).toBe(0.01);
    expect(req.requirements.maxLatencyMs).toBe(2000);
  });

  it("tells the engine what it may name, and nothing else", () => {
    const { world, devices, capabilities } = room();
    const summary = minimiseRoomState(world, devices, capabilities);

    expect(summary.state).toEqual({
      "tv.power": "on", "tv.input": "hdmi1", "tv.volume": 35,
      "tv.muted": false, "content.state": "playing",
    });
    expect(summary.devices).toEqual([
      { id: "ps5", type: "game_console", port: "hdmi2" },
      { id: "appletv", type: "streaming_stick" },
    ]);
    expect(summary.capabilities).toContain("tv.input.switch");
  });
});

describe("what must never leave the television", () => {
  it("sends no device names, vendors, models, IPs or MACs", () => {
    const { world, devices, capabilities } = room();
    const body = JSON.stringify(buildTaskRequest({ goal, world, devices, capabilities }));

    for (const leak of ["PlayStation 5", "Andy", "Sony", "CFI-1216A", "10.0.0.5", "aa:bb:cc:dd:ee:ff", "mdns"]) {
      expect(body, `"${leak}" must not cross the boundary`).not.toContain(leak);
    }
    // The local handle survives, because a plan has to be able to name a target.
    expect(body).toContain("ps5");
  });

  it("coarsens occupancy and drops the inference about children entirely", () => {
    const { world, devices, capabilities } = room();
    applyPerception(world, {
      type: "occupancy_changed", value: { peopleCount: 3 }, confidence: 0.9,
      timestamp: new Date().toISOString(),
    });
    applyPerception(world, {
      type: "child_detected", value: {}, confidence: 0.8,
      timestamp: new Date().toISOString(),
    });

    const summary = minimiseRoomState(world, devices, capabilities);
    const body = JSON.stringify(buildTaskRequest({ goal, world, devices, capabilities }));

    // "Someone is in" is enough for every plan we have; "three people" is a fact
    // about a household.
    expect(summary.occupancy).toBe("occupied");
    expect(body).not.toContain("peopleCount");
    expect(body).not.toContain("childPresent");
    expect(body).not.toContain("room.");
    expect(JSON.stringify(summary)).not.toContain("child");
  });

  it("sends no raw frame, audio, transcript or face data even when the world holds one", () => {
    const { world, devices, capabilities } = room();
    // The perception gate would already have stopped these; belt and braces,
    // because the mapper must not be the only thing standing in the way — nor
    // the thing that lets them through if the gate is ever bypassed.
    world.observe({ path: "room.transcript", value: "we should cancel the subscription", source: "perception" });
    world.observe({ path: "room.snapshotDataUrl", value: "data:image/png;base64,AAAA", source: "perception" });
    world.observe({ path: "users.0.name", value: "Andy", source: "user" });

    const body = JSON.stringify(buildTaskRequest({ goal, world, devices, capabilities }));
    for (const leak of ["transcript", "cancel the subscription", "data:image", "base64", "Andy"]) {
      expect(body, `"${leak}" must not cross the boundary`).not.toContain(leak);
    }
  });

  it("sends only an allowlist, so a new world path cannot leak by default", () => {
    const { world, devices, capabilities } = room();
    world.observe({ path: "tv.serialNumber", value: "SN-12345", source: "tool" });
    world.observe({ path: "account.email", value: "andy@example.com", source: "user" });

    const summary = minimiseRoomState(world, devices, capabilities);
    expect(Object.keys(summary.state)).not.toContain("tv.serialNumber");
    expect(Object.keys(summary.state)).not.toContain("account.email");
    expect(JSON.stringify(summary)).not.toContain("SN-12345");
    expect(JSON.stringify(summary)).not.toContain("example.com");
  });

  it("sends no conversation history", () => {
    const { world, devices, capabilities } = room();
    const req = buildTaskRequest({
      goal, world, devices, capabilities,
      utterance: "put the PlayStation on",
    });
    // One utterance, because the goal came from it. Not the transcript of a
    // household's evening.
    expect(req.task.instruction).toContain("put the PlayStation on");
    expect(req.task.context).not.toContain("put the PlayStation on");
    // Once — the goal was built from it. Not twice, and not a transcript of a
    // household's evening.
    expect(JSON.stringify(req).match(/PlayStation/g)).toHaveLength(1);
  });
});
