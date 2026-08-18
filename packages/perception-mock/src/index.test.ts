import { describe, it, expect } from "vitest";
import {
  PerceptionManager, PolicyEngine, WorldModel, W, defaultRules,
  type PerceptionEvent, type PerceptionSource,
} from "@tv-ai-agent/core";
import { createScriptedSource, createLeakySource, occupancyScript } from "./index.js";

/**
 * The perception path, end to end, with no camera: consent, gate, sanitising,
 * world update. The two tests that matter are the ones about a source that
 * misbehaves, because a well-behaved source proves nothing about a boundary.
 */

function setup(opts: { consent?: boolean | undefined; source?: PerceptionSource } = {}) {
  const world = new WorldModel();
  const events: PerceptionEvent[] = [];
  const grants: (string | undefined)[] = [];
  const asked: string[] = [];
  const source = opts.source ?? createScriptedSource({ script: occupancyScript() });

  const manager = new PerceptionManager({
    world,
    policy: new PolicyEngine(defaultRules()),
    ...(opts.consent === undefined ? {} : {
      confirm: ({ prompt }) => { asked.push(prompt); return opts.consent!; },
    }),
    onEvent: (event) => events.push(event),
    onGrantChange: (grant, sourceId) => grants.push(grant ? sourceId : undefined),
  });
  manager.register(source);
  return { manager, world, events, grants, asked, source: source as ReturnType<typeof createScriptedSource> };
}

describe("nothing senses the room without being allowed to", () => {
  it("does not start a source when consent is declined", async () => {
    const { manager, source, world } = setup({ consent: false });
    const result = await manager.start(source.id);
    expect(result).toMatchObject({ started: false });
    expect(source.tick()).toBe(false);      // never handed a callback
    expect(manager.active).toEqual([]);
    expect(world.paths()).toEqual([]);
  });

  it("does not start a source when there is nobody to ask", async () => {
    const { manager, source } = setup();     // no confirm handler at all
    const result = await manager.start(source.id);
    expect(result).toMatchObject({ started: false, reason: expect.stringMatching(/nothing can ask/) });
    expect(manager.active).toEqual([]);
  });

  it("says what it wants to sense when it asks", async () => {
    const { manager, source, asked } = setup({ consent: true });
    await manager.start(source.id);
    // A person deciding this needs to know a camera is involved.
    expect(asked.join(" ")).toMatch(/camera/i);
  });

  it("starts once consent is given, and reports the grant", async () => {
    const { manager, source, grants } = setup({ consent: true });
    const result = await manager.start(source.id);
    expect(result.started).toBe(true);
    expect(manager.grantFor(source.id)?.sensors).toEqual(["camera"]);
    // What a host wires the "camera is live" indicator to.
    expect(grants).toEqual([source.id]);
  });
});

describe("what a granted source can actually do", () => {
  it("moves the world, one derived fact at a time", async () => {
    const { manager, source, world, events } = setup({ consent: true });
    await manager.start(source.id);

    source.tick();
    expect(world.value(W.roomPeopleCount)).toBe(1);
    source.tick();
    expect(world.value(W.roomPeopleCount)).toBe(3);
    source.tick();
    expect(world.value(W.roomAmbientLight)).toBe("low");
    source.tick();
    expect(world.value(W.roomPeopleCount)).toBe(0);

    expect(events).toHaveLength(4);
    expect(world.get(W.roomPeopleCount)?.source).toBe("perception");
  });

  it("stops within one event when the grant is revoked", async () => {
    const { manager, source, world } = setup({ consent: true });
    await manager.start(source.id);
    source.tick();
    expect(world.value(W.roomPeopleCount)).toBe(1);

    await manager.revoke(source.id);
    source.tick();                            // the script would have said 3
    expect(world.value(W.roomPeopleCount)).toBe(1);
    expect(manager.active).toEqual([]);
    expect(manager.grantFor(source.id)).toBeUndefined();
  });

  it("expires a time-boxed grant on the next event, with no timer to leak", async () => {
    let clock = 1000;
    const world = new WorldModel({ now: () => clock });
    const source = createScriptedSource({ script: occupancyScript(() => clock), now: () => clock });
    const manager = new PerceptionManager({
      world,
      policy: new PolicyEngine(defaultRules()),
      confirm: () => true,
      now: () => clock,
    });
    manager.register(source);
    await manager.start(source.id, { forMs: 5000 });

    source.tick();
    expect(world.known(W.roomPeopleCount)).toBe(true);
    clock += 10_000;
    source.tick();
    expect(manager.active).toEqual([]);
    expect(manager.grantFor(source.id)).toBeUndefined();
  });
});

describe("a source that misbehaves", () => {
  it("cannot put a frame, a data URL or a transcript anywhere", async () => {
    const leaky = createLeakySource();
    const { manager, world, events } = setup({ consent: true, source: leaky });
    await manager.start(leaky.id);
    leaky.tick();

    // The derived fact survives; nothing else does.
    expect(world.value(W.roomPeopleCount)).toBe(2);
    const everything = JSON.stringify({
      world: world.dump(),
      summary: world.summarize(),
      events,
    });
    for (const leak of ["frame", "snapshot", "dataUrl", "data:image", "transcript", "faces", "embedding"]) {
      expect(everything, `"${leak}" must not survive the gate`).not.toMatch(new RegExp(leak, "i"));
    }
  });

  it("cannot claim more confidence than exists", async () => {
    const leaky = createLeakySource();
    const { manager, world } = setup({ consent: true, source: leaky });
    await manager.start(leaky.id);
    leaky.tick();
    expect(world.get(W.roomPeopleCount)?.confidence).toBe(1);
  });

  it("cannot keep writing after being revoked, even ignoring stop()", async () => {
    const leaky = createLeakySource();
    const { manager, world } = setup({ consent: true, source: leaky });
    await manager.start(leaky.id);
    leaky.tick();
    await manager.revoke(leaky.id);

    // `stop()` here is a deliberate no-op, so the source keeps firing — which is
    // exactly why the check is on our side of the boundary.
    world.forget(W.roomPeopleCount);
    leaky.tick();
    leaky.tick();
    expect(leaky.sent).toBe(3);
    expect(world.known(W.roomPeopleCount)).toBe(false);
  });
});
