import { describe, it, expect } from "vitest";
import {
  CapabilityGraph, DeviceGraph, WorldModel, W, applyPerception,
  createTvCapabilities, createMediaCapabilities,
} from "@hearthkit/core";
import { buildCompletionRequest, minimiseRoomState, REQUIRED_KEYS } from "./task-mapper.js";

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

describe("request mapping", () => {
  it("is an OpenAI-compatible completion, because that is what the service is", () => {
    const { world, devices, capabilities } = room();
    const req = buildCompletionRequest({ goal, world, devices, capabilities });

    // `auto` is the entire routing trigger. Pin a model and ModelPilot stops
    // being a router.
    expect(req.model).toBe("auto");
    expect(req.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(req.messages[0]?.content).toContain(REQUIRED_KEYS.join(", "));
  });

  it("sends the three routing knobs the service actually reads, and no others", () => {
    const { world, devices, capabilities } = room();
    const req = buildCompletionRequest({ goal, world, devices, capabilities });

    expect(Object.keys(req.metadata).sort()).toEqual(["latency_priority", "max_cost", "quality_threshold"]);
    expect(Object.keys(req).sort()).toEqual(["messages", "metadata", "model", "reasoning_effort"]);
  });

  it("asks for a decision rather than a deliberation", () => {
    const { world, devices, capabilities } = room();
    // Measured, not assumed: the first live call spent 704 of 748 completion
    // tokens reasoning about a four-field answer and took 20.3s. With this it
    // took 4.4s, cost a tenth as much, and answered slightly better. On a
    // television 20s is not a latency, it is a bug report.
    expect(buildCompletionRequest({ goal, world, devices, capabilities }).reasoning_effort)
      .toBe("minimal");

    // And it can be left off entirely, for a catalogue whose models would
    // reject an unrecognised field.
    const bare = buildCompletionRequest({ goal, world, devices, capabilities, reasoningEffort: null });
    expect("reasoning_effort" in bare).toBe(false);
  });

  it("asks for a model that can actually emit strict JSON", () => {
    const { world, devices, capabilities } = room();
    const req = buildCompletionRequest({ goal, world, devices, capabilities });

    // Price is part of a router's score, so the cheapest eligible candidate wins
    // more often than not. The threshold is what keeps the weak end of a
    // catalogue out — a model that cannot hold a schema does not fail loudly, it
    // answers with prose, and that costs a round trip to discover.
    expect(req.metadata.quality_threshold).toBeGreaterThan(0.8);
  });

  it("never sets stream, which the service answers with 400", () => {
    const { world, devices, capabilities } = room();
    const req = buildCompletionRequest({ goal, world, devices, capabilities });
    expect((req as Record<string, unknown>).stream).toBeUndefined();
  });

  it("declares no policy the service does not enforce", () => {
    const { world, devices, capabilities } = room();
    const body = JSON.stringify(buildCompletionRequest({ goal, world, devices, capabilities }));

    // These were sent for a release and read by nobody. A retention guarantee
    // in a field the server ignores is worse than no guarantee: it reads like
    // one. The real boundary is `minimiseRoomState` and the tests below.
    for (const claim of ["dataPolicy", "retentionRequirement", "trainingUse", "toolEgress", "approvalMode"]) {
      expect(body, `${claim} was a promise nothing kept`).not.toContain(claim);
    }
  });

  it("honours the caller's budget ceiling", () => {
    const { world, devices, capabilities } = room();
    const req = buildCompletionRequest({
      goal, world, devices, capabilities, maxTaskBudget: 0.01,
    });
    expect(req.metadata.max_cost).toBe(0.01);
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
    const body = JSON.stringify(buildCompletionRequest({ goal, world, devices, capabilities }));

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
    const body = JSON.stringify(buildCompletionRequest({ goal, world, devices, capabilities }));

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

    const body = JSON.stringify(buildCompletionRequest({ goal, world, devices, capabilities }));
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
    const req = buildCompletionRequest({
      goal, world, devices, capabilities,
      utterance: "put the PlayStation on",
    });
    const user = req.messages[1]?.content ?? "";
    expect(user).toContain("put the PlayStation on");
    // Once — the goal was built from it. Not twice, and not a transcript of a
    // household's evening.
    expect(JSON.stringify(req).match(/PlayStation/g)).toHaveLength(1);
  });
});
