import { describe, it, expect } from "vitest";
import {
  Agent, DeviceGraph, createManualSource, runDiscovery, matchSkill,
  type PlanOutcome, type StepOutcome,
} from "@tv-ai-agent/core";
import { createScriptedClient } from "@tv-ai-agent/llm-connectors";
import { targets, type Target } from "./mocks.js";

/**
 * The P0 scenarios, run headless on every adapter.
 *
 * The tool-level acceptance test already proves that the same commands produce
 * the same *tool calls* everywhere. This proves the layer above it: the same
 * intent produces the same **plan**, the same step statuses and the same end
 * state on every target — which is a stronger claim, because a plan carries
 * preconditions, verification and a device graph, and any of those could have
 * become platform-specific without anyone noticing.
 *
 * The room is declared identically for every target, so the only variable is the
 * adapter. That is the point: 「我要打 PS5」 must resolve to HDMI2 through the
 * device graph on all six, and the string `hdmi2` must appear in no goal.
 *
 * What is *not* asserted is that every target succeeds. Tizen cannot switch
 * inputs at all — `setInputSource` is a partner-signed API and the adapter says
 * so — and a test that demanded success everywhere could only pass by pretending
 * otherwise. So the **plan** must be identical everywhere, and where a platform
 * genuinely cannot perform a step the outcome must be `unsupported`, the
 * capability must be withdrawn, and the TV must be left alone. That is the
 * cross-target guarantee worth having: same reasoning, honest results.
 */

/**
 * What switching an input actually does on each target, and why.
 *
 * Three different honest answers for one identical plan, which is the most
 * useful thing this file records:
 *
 *  - `verified` — the write took and the read-back agrees.
 *  - `unsupported` — the adapter refuses up front, because the API is
 *    partner-signed. Tizen and webOS both say so rather than pretending.
 *  - `failed` — the write was *accepted* and nothing happened. That is what this
 *    mock does, and it is the shape that matters: `execute -> assume success`
 *    would have reported it as done. (The real AOSP adapter is blunter — it
 *    refuses `setInputSource` up front, so on the emulator the same utterance
 *    comes back `unsupported`. Keeping the mock as it is keeps a target in the
 *    suite for the accepted-and-ignored case, which is the one no adapter can be
 *    relied on to self-report.)
 *
 * A target moving to `verified` here without its adapter gaining a real capability
 * means verification has been weakened, so these are pinned by name.
 */
const INPUT_SWITCH: Record<string, "verified" | "unsupported" | "failed"> = {
  web: "verified",
  tizen: "unsupported",
  aosp: "failed",
  webos: "unsupported",
  titan: "verified",
  xumo: "verified",
};

const ROOM = [
  { id: "tv", type: "tv" as const, name: "Living Room TV", connection: { kind: "internal" as const }, source: "manual" as const },
  { id: "ps5", type: "game_console" as const, name: "PlayStation 5", connection: { kind: "hdmi" as const, port: "hdmi2" as const }, source: "manual" as const },
  { id: "stb", type: "stb" as const, name: "Set-top box", connection: { kind: "hdmi" as const, port: "hdmi3" as const }, source: "manual" as const },
];

async function agentFor(target: Target) {
  const platform = target.make();
  await platform.init();
  const devices = new DeviceGraph();
  await runDiscovery(devices, [createManualSource(ROOM)]);
  const agent = new Agent({
    platform,
    // Offline brain: plan mode never consults it for these goals, and having it
    // here proves that — a scripted client would answer very differently.
    llm: createScriptedClient(),
    devices,
    confirm: () => true,
  });
  return { platform, agent };
}

/** What was planned — must be identical on every target. */
const plan = (outcome: PlanOutcome): { capability: string; args: Record<string, unknown> }[] =>
  outcome.plan.steps.map((s) => ({ capability: s.action.capabilityId, args: s.action.args }));

/** `capability:status` per step — what actually happened. */
const shape = (outcome: PlanOutcome): string[] =>
  outcome.outcomes.map((o: StepOutcome) => `${o.step.action.capabilityId}:${o.status}`);

async function onEveryTarget<T>(
  run: (ctx: Awaited<ReturnType<typeof agentFor>>) => Promise<T>,
): Promise<{ name: string; result: T }[]> {
  const out: { name: string; result: T }[] = [];
  for (const target of targets()) {
    const ctx = await agentFor(target);
    try {
      out.push({ name: target.name, result: await run(ctx) });
    } finally {
      target.teardown();
    }
  }
  return out;
}

describe("plan-level acceptance", () => {
  it("Scenario A — 切到 HDMI2 plans and verifies identically everywhere", async () => {
    const runs = await onEveryTarget(async ({ agent, platform }) => {
      const outcome = await agent.pursueIntent("切到 HDMI2");
      return {
        plan: plan(outcome!),
        shape: shape(outcome!),
        withdrawn: agent.capabilities.get("tv.input.switch")?.status === "withdrawn",
        claimsHdmi2: agent.world.value("tv.input") === "hdmi2",
        input: await platform.system.getInputSource().catch(() => "unknown"),
      };
    });

    for (const { name, result } of runs) {
      // The plan is the cross-target guarantee: same capability, same argument,
      // derived from the device graph, on every OS.
      expect(result.plan, name).toEqual([{ capability: "tv.input.switch", args: { source: "hdmi2" } }]);
      expect(result.shape, name).toEqual([`tv.input.switch:${INPUT_SWITCH[name]}`]);

      if (INPUT_SWITCH[name] === "verified") {
        expect(result.input, name).toBe("hdmi2");
      } else {
        // Whichever way it went wrong, the TV was left alone and the agent does
        // not believe it switched.
        expect(result.input, name).not.toBe("hdmi2");
        expect(result.claimsHdmi2, name).toBe(false);
      }
      // Only an `unsupported` capability is withdrawn. A failure is a bad moment,
      // not a missing capability, and withdrawing over one would disable a
      // working TV on a single hiccup.
      expect(result.withdrawn, name).toBe(INPUT_SWITCH[name] === "unsupported");
    }
  });

  it("Scenario B — 我要打 PS5 finds the port through the device graph on every OS", async () => {
    const runs = await onEveryTarget(async ({ agent, platform }) => {
      const outcome = await agent.pursueIntent("我要打 PS5");
      return {
        plan: plan(outcome!),
        shape: shape(outcome!),
        unreachable: (outcome!.plan.unreachable ?? []).map((p) => p.path),
        input: await platform.system.getInputSource().catch(() => "unknown"),
      };
    });

    for (const { name, result } of runs) {
      // Derived from the graph on every target, written down on none of them.
      expect(result.plan, name).toEqual([{ capability: "tv.input.switch", args: { source: "hdmi2" } }]);
      // No CEC anywhere yet, so waking the console is honestly out of reach —
      // and it is out of reach the same way on all six.
      expect(result.unreachable, name).toEqual(["devices.ps5.power"]);
      // Same three honest answers as Scenario A: the goal is bigger, the
      // capability it needs is the same one.
      expect(result.shape, name).toEqual([`tv.input.switch:${INPUT_SWITCH[name]}`]);
      if (INPUT_SWITCH[name] === "verified") expect(result.input, name).toBe("hdmi2");
    }
  });

  it("Scenario D — 小聲一點 resolves against world state, not a re-read", async () => {
    const runs = await onEveryTarget(async ({ agent, platform }) => {
      await platform.system.setVolume(40);
      const reads: string[] = [];
      agent.events.on("tool:call", (e) => { if (e.name === "get_volume") reads.push(e.name); });

      const first = await agent.pursueIntent("小聲一點");
      const readsAfterFirst = reads.length;
      const second = await agent.pursueIntent("小聲一點");

      return {
        shapes: [shape(first!), shape(second!)],
        volume: await platform.system.getVolume(),
        readsAfterFirst,
        readsTotal: reads.length,
      };
    });

    for (const { name, result } of runs) {
      expect(result.shapes, name).toEqual([
        ["tv.audio.set_volume:verified"],
        ["tv.audio.set_volume:verified"],
      ]);
      expect(result.volume, name).toBe(20);
      // One look on the way in, and never again: the world remembers.
      expect(result.readsAfterFirst, name).toBe(1);
      expect(result.readsTotal, name).toBe(1);
    }
  });

  it("Scenario C — 我要看電影 is identical wherever the platform has media at all", async () => {
    const runs = await onEveryTarget(async ({ agent, platform }) => ({
      shape: shape((await agent.pursueIntent("我要看電影"))!),
      hasMedia: platform.has("media"),
    }));

    const withMedia = runs.filter((r) => r.result.hasMedia);
    expect(withMedia.length).toBeGreaterThan(1);
    for (const { name, result } of withMedia) {
      // `unverified`, not `verified`: no HAL read for playback state, and saying
      // "done" for something nothing can confirm is the failure this whole
      // design exists to prevent.
      expect(result.shape, name).toEqual(["content.resume:unverified"]);
    }
    // A platform without media plans nothing rather than improvising — the same
    // capability gating the tool-level test already asserts, one layer up.
    for (const { name, result } of runs.filter((r) => !r.result.hasMedia)) {
      expect(result.shape, name).toEqual([]);
    }
  });

  it("declines the same way everywhere when nobody approves", async () => {
    // Built by hand rather than through the helper: this one needs a *different*
    // agent per target (one that declines), which is exactly the axis the helper
    // holds fixed.
    for (const target of targets()) {
      const platform = target.make();
      await platform.init();
      const devices = new DeviceGraph();
      await runDiscovery(devices, [createManualSource(ROOM)]);
      const agent = new Agent({ platform, llm: createScriptedClient(), devices, confirm: () => false });
      try {
        const outcome = await agent.pursueIntent("切到 HDMI2");
        // Denied *before* anything is attempted, so even a platform that could
        // not have done it never gets asked.
        expect(shape(outcome!), target.name).toEqual(["tv.input.switch:denied"]);
        // Declining is not failing, and the TV was left alone.
        expect(await platform.system.getInputSource(), target.name).not.toBe("hdmi2");
      } finally {
        target.teardown();
      }
    }
  });

  it("routes an unrecognised utterance back to conversation on every target", async () => {
    expect(matchSkill("what's on tonight?")).toBeUndefined();
    const runs = await onEveryTarget(async ({ agent }) => agent.pursueIntent("what's on tonight?"));
    for (const { name, result } of runs) {
      expect(result, name).toBeUndefined();   // "not plan work" — the host calls run()
    }
  });
});
