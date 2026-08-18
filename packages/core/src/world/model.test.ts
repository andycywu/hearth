import { describe, it, expect } from "vitest";
import { WorldModel } from "./model.js";
import { W } from "./state.js";
import { applyPerception } from "../perception/events.js";

describe("WorldModel", () => {
  it("answers unknown for what it has never been told", () => {
    const world = new WorldModel();
    expect(world.known(W.tvVolume)).toBe(false);
    expect(world.value(W.tvVolume)).toBeUndefined();
  });

  it("prefers stronger evidence over a newer weak claim", () => {
    let now = 1000;
    const world = new WorldModel({ now: () => now });
    world.observe({ path: W.tvVolume, value: 35, source: "tool" });
    now = 2000;
    world.observe({ path: W.tvVolume, value: 10, source: "inferred" });
    expect(world.value(W.tvVolume)).toBe(35);
    // The losing claim is still recorded — an adapter that keeps losing these
    // is the thing we would want to notice.
    expect(world.history.at(-1)).toMatchObject({ rejected: true, to: 10 });
  });

  it("lets an action's own effect override an earlier read", () => {
    let now = 1000;
    const world = new WorldModel({ now: () => now });
    world.observe({ path: W.tvVolume, value: 30, source: "tool" });
    now = 2000;
    world.observe({ path: W.tvVolume, value: 40, source: "assumed", override: true });
    expect(world.value(W.tvVolume)).toBe(40);
  });

  it("decays confidence past the TTL instead of forgetting", () => {
    let now = 0;
    const world = new WorldModel({ now: () => now });
    world.observe({ path: W.roomPeopleCount, value: 2, source: "perception", ttlMs: 1000 });
    expect(world.known(W.roomPeopleCount)).toBe(true);
    now = 4000;
    expect(world.stale(W.roomPeopleCount)).toBe(true);
    expect(world.get(W.roomPeopleCount)?.confidence).toBeLessThan(0.4);
    expect(world.get(W.roomPeopleCount)?.value).toBe(2); // still a prior
  });

  it("summarizes only what it actually knows", () => {
    const world = new WorldModel();
    world.observe({ path: W.tvVolume, value: 35, source: "tool" });
    world.observe({ path: W.tvInput, value: "hdmi2", source: "tool" });
    const summary = world.summarize();
    expect(summary).toContain("tv.volume: 35");
    expect(summary).toContain("tv.input: hdmi2");
    expect(summary).not.toContain("unknown");
  });

  it("nests a snapshot and survives a dump/restore round trip", () => {
    const world = new WorldModel();
    world.observe({ path: W.device("ps5", "power"), value: "standby", source: "tool" });
    expect(world.snapshot()).toMatchObject({ devices: { ps5: { power: { value: "standby" } } } });

    const copy = new WorldModel();
    copy.restore(world.dump());
    expect(copy.value(W.device("ps5", "power"))).toBe("standby");
  });
});

describe("perception", () => {
  it("turns an occupancy event into a decaying room fact", () => {
    const world = new WorldModel();
    const changed = applyPerception(world, {
      type: "occupancy_changed",
      value: { peopleCount: 3 },
      confidence: 0.88,
      timestamp: new Date().toISOString(),
    });
    expect(changed).toBe(1);
    expect(world.value(W.roomPeopleCount)).toBe(3);
    expect(world.get(W.roomPeopleCount)?.source).toBe("perception");
  });

  it("stops treating an old sighting as current", () => {
    const world = new WorldModel();
    // Yesterday's occupancy is not evidence about the room now — it survives as
    // a prior, and `known()` says no.
    applyPerception(world, {
      type: "occupancy_changed",
      value: { peopleCount: 3 },
      confidence: 0.9,
      timestamp: new Date(Date.now() - 24 * 3600_000).toISOString(),
    });
    expect(world.known(W.roomPeopleCount)).toBe(false);
    expect(world.get(W.roomPeopleCount)?.value).toBe(3);
  });

  it("reports presence when it cannot count people", () => {
    const world = new WorldModel();
    applyPerception(world, {
      type: "person_entered",
      value: {},
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    });
    expect(world.value("room.occupied")).toBe(true);
    expect(world.known(W.roomPeopleCount)).toBe(false); // never invents a number
  });
});
