import { describe, it, expect } from "vitest";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import { Agent } from "./agent.js";
import { DeviceGraph } from "../devices/graph.js";
import { matchSkill, isPlannable } from "../skills/match.js";
import type { LlmClient, CompletionResult } from "../llm/client.js";

/**
 * The four P0 scenarios, driven the way a host drives them: an utterance, a
 * matched scenario, a goal, a plan, and a verified outcome. The chat path is
 * untouched and still there for everything this does not recognise.
 */

const silentLlm: LlmClient = {
  id: "silent",
  complete: async (): Promise<CompletionResult> => ({
    wantsToolCalls: false,
    message: { role: "assistant", content: "ok" },
  }),
};

function agentWithRoom(opts: { confirm?: boolean; devices?: boolean } = {}) {
  const devices = new DeviceGraph();
  if (opts.devices !== false) {
    devices.observe({ id: "ps5", name: "PlayStation 5", type: "game_console", connection: { kind: "hdmi", port: "hdmi2" }, source: "manual", confidence: 1 });
    devices.observe({ id: "stb", name: "Set-top box", type: "stb", connection: { kind: "hdmi", port: "hdmi3" }, source: "manual", confidence: 1 });
  }
  const asked: string[] = [];
  const platform = createWebAdapter();
  const agent = new Agent({
    platform,
    llm: silentLlm,
    devices,
    ...(opts.confirm === false ? {} : { confirm: (req) => { asked.push(req.name); return true; } }),
  });
  const calls: string[] = [];
  agent.events.on("tool:call", (e) => calls.push(e.name));
  return { agent, platform, devices, asked, calls };
}

describe("plan mode — Scenario A: 切到 HDMI2", () => {
  it("recognises the utterance, plans one step, and verifies it", async () => {
    const { agent, platform } = agentWithRoom();
    const match = matchSkill("切到 HDMI2")!;
    expect(match.skill.id).toBe("switch_input");
    expect(isPlannable(match)).toBe(true);

    const outcome = await agent.pursueSkill(match.skill, match.params);
    expect(outcome.outcomes.map((o) => o.status)).toEqual(["verified"]);
    expect(await platform.system.getInputSource()).toBe("hdmi2");
    expect(agent.describe(outcome)).toMatch(/^Done: tv\.input\.switch\(source=hdmi2\)\./);
  });

  it("falls through to chat when the utterance names no port", () => {
    const match = matchSkill("switch input")!;
    // Recognisable intent, unplannable goal. Better for the model to ask which
    // input than for the agent to pick one.
    expect(isPlannable(match)).toBe(false);
  });

  it("asks before taking the screen away, and a refusal is not a failure", async () => {
    const { agent } = agentWithRoom({ confirm: false });
    const outcome = await agent.pursueSkill("switch_input", { source: "hdmi2" });
    expect(outcome.outcomes[0]?.status).toBe("denied");
    expect(agent.describe(outcome)).toMatch(/Skipped .*needs confirmation/);
  });
});

describe("plan mode — Scenario B: 我要打 PS5", () => {
  it("plans a multi-step goal with the port looked up, not written down", async () => {
    const { agent, platform } = agentWithRoom();
    const match = matchSkill("我要打 PS5")!;
    expect(match.skill.id).toBe("gaming_session");

    const steps: string[] = [];
    agent.events.on("plan:step", (e) => steps.push(`${e.outcome.step.action.capabilityId}:${e.outcome.status}`));

    const outcome = await agent.pursueSkill(match.skill, match.params);
    // No CEC transport on this platform, so waking the console is a capability
    // the graph knows about and nothing can perform — the plan says so instead
    // of pretending the console is awake.
    expect(outcome.plan.steps.map((s) => s.action.capabilityId)).toEqual(["tv.input.switch"]);
    expect(outcome.plan.steps[0]?.action.args).toEqual({ source: "hdmi2" });
    expect(outcome.plan.unreachable?.map((p) => p.path)).toEqual(["devices.ps5.power"]);
    expect(steps).toEqual(["tv.input.switch:verified"]);
    expect(await platform.system.getInputSource()).toBe("hdmi2");
  });

  it("follows the console when it moves, with no code change", async () => {
    const { agent, devices, platform } = agentWithRoom();
    devices.observe({ id: "ps5", connection: { kind: "hdmi", port: "hdmi4" }, source: "manual", confidence: 1 });
    await agent.pursueSkill("gaming_session", { device: "ps5" });
    expect(await platform.system.getInputSource()).toBe("hdmi4");
  });

  it("says it does not know where the console is, rather than guessing", async () => {
    const { agent } = agentWithRoom({ devices: false });
    const outcome = await agent.pursueSkill("gaming_session", { device: "ps5" });
    expect(outcome.blocked).toMatch(/don't know where/i);
    expect(outcome.outcomes).toEqual([]);
    expect(agent.describe(outcome)).toBe(outcome.blocked);
  });
});

describe("plan mode — Scenario C: 我要看電影", () => {
  it("reaches playback through a capability, and does not claim more than it can check", async () => {
    const { agent } = agentWithRoom();
    const outcome = await agent.pursueSkill(matchSkill("我要看電影")!.skill, {});
    expect(outcome.outcomes.map((o) => o.status)).toEqual(["unverified"]);
    expect(agent.describe(outcome)).toMatch(/can't confirm it/);
  });
});

describe("plan mode — Scenario D: 小聲一點", () => {
  it("looks once, then resolves the relative intent against what it knows", async () => {
    const { agent, platform, calls } = agentWithRoom();
    await platform.system.setVolume(40);

    const outcome = await agent.pursueSkill(matchSkill("小聲一點")!.skill, matchSkill("小聲一點")!.params);
    expect(outcome.outcomes.map((o) => o.status)).toEqual(["verified"]);
    expect(await platform.system.getVolume()).toBe(30);

    // The second one costs no read at all: the world already knows, which is the
    // whole reason it exists.
    const before = calls.filter((c) => c === "get_volume").length;
    await agent.pursueSkill("quieter", {});
    expect(await platform.system.getVolume()).toBe(20);
    expect(calls.filter((c) => c === "get_volume").length - before).toBe(0);
  });

  it("takes a step size from the utterance", async () => {
    const { agent, platform } = agentWithRoom();
    await platform.system.setVolume(40);
    const match = matchSkill("turn it down by 5")!;
    expect(match.params).toEqual({ step: 5 });
    await agent.pursueSkill(match.skill, match.params);
    expect(await platform.system.getVolume()).toBe(35);
  });

  it("never goes below zero", async () => {
    const { agent, platform } = agentWithRoom();
    await platform.system.setVolume(4);
    await agent.pursueSkill("quieter", {});
    expect(await platform.system.getVolume()).toBe(0);
  });
});

describe("plan mode — the two paths", () => {
  it("emits a plan lifecycle a renderer can follow", async () => {
    const { agent } = agentWithRoom();
    const seen: string[] = [];
    agent.events.on("plan:start", () => seen.push("start"));
    agent.events.on("plan:step", () => seen.push("step"));
    agent.events.on("plan:end", () => seen.push("end"));
    await agent.pursueSkill("switch_input", { source: "hdmi2" });
    expect(seen).toEqual(["start", "step", "end"]);
  });

  it("leaves conversation alone", async () => {
    const { agent } = agentWithRoom();
    expect(matchSkill("what's the weather like?")).toBeUndefined();
    expect(await agent.run("what's the weather like?")).toBe("ok");
  });

  it("shares one world between both paths", async () => {
    const { agent, platform } = agentWithRoom();
    await platform.system.setVolume(40);
    await agent.pursueSkill("switch_input", { source: "hdmi2" });
    // The plan's verified read-back is a fact the chat path can now use.
    expect(agent.world.value("tv.input")).toBe("hdmi2");
  });
});
