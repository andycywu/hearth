import { describe, it, expect } from "vitest";
import { Agent } from "./agent.js";
import { defineTool } from "../tools/registry.js";
import { PolicyEngine, defaultRules, parentalRules } from "../policy/policy.js";
import { createWebAdapter } from "@hearthkit/adapter-web";
import type { LlmClient, CompletionResult } from "../llm/client.js";
import type { PlatformProvider } from "@hearthkit/platform-api";
import { TvUnsupportedError } from "@hearthkit/platform-api";

const finalLlm: LlmClient = {
  id: "echo",
  complete: async (): Promise<CompletionResult> => ({
    wantsToolCalls: false,
    message: { role: "assistant", content: "ok" },
  }),
};

function fakePlatform(): PlatformProvider {
  let volume = 10;
  return {
    device: { os: "web", osVersion: "0", soc: "unknown", model: "test", capabilities: {} },
    system: {
      getVolume: async () => volume,
      setVolume: async (v) => { volume = v; },
      getMute: async () => false,
      setMute: async () => {},
      getInputSource: async () => "tv",
      setInputSource: async () => {},
      powerStandby: async () => {},
    },
    apps: {
      listInstalledApps: async () => [{ id: "netflix", name: "Netflix" }],
      launchApp: async () => {},
      getForegroundApp: async () => null,
      findAppsByName: async () => [{ id: "netflix", name: "Netflix" }],
    },
    navigation: { sendKey: async () => {} },
    network: { isOnline: async () => true, connectionType: async () => "wifi" },
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    has: () => true,
    init: async () => {},
  };
}

describe("Agent", () => {
  it("executes a tool call then returns the final answer", async () => {
    let step = 0;
    const llm: LlmClient = {
      id: "fake",
      complete: async (): Promise<CompletionResult> => {
        step++;
        if (step === 1) {
          return {
            wantsToolCalls: true,
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "set_volume", args: { level: 25 } }],
            },
          };
        }
        return { wantsToolCalls: false, message: { role: "assistant", content: "Done, volume set to 25." } };
      },
    };

    const agent = new Agent({ platform: fakePlatform(), llm });
    const out = await agent.run("turn it up a bit");
    expect(out).toContain("25");
  });

  it("retains history across turns and clears it on reset", async () => {
    const llm: LlmClient = {
      id: "echo",
      complete: async (): Promise<CompletionResult> => ({
        wantsToolCalls: false,
        message: { role: "assistant", content: "ok" },
      }),
    };
    const agent = new Agent({ platform: fakePlatform(), llm });
    await agent.run("first");
    await agent.run("second");
    expect(agent.historyLength).toBeGreaterThan(0);
    agent.reset();
    expect(agent.historyLength).toBe(0);
  });

  it("aborts a turn that exceeds the time budget", async () => {
    const slowLlm: LlmClient = {
      id: "slow",
      complete: () => new Promise(() => { /* never resolves */ }),
    };
    const agent = new Agent({ platform: fakePlatform(), llm: slowLlm, turnTimeoutMs: 20 });
    await expect(agent.run("hang")).rejects.toThrow(/time budget/i);
  });

  it("registers and executes a custom tool", async () => {
    let called = false;
    const greet = defineTool({ name: "greet", description: "greet", parameters: {} }, async () => {
      called = true;
      return { ok: true };
    });
    let step = 0;
    const llm: LlmClient = {
      id: "f",
      complete: async (): Promise<CompletionResult> => {
        step++;
        return step === 1
          ? { wantsToolCalls: true, message: { role: "assistant", content: "", toolCalls: [{ id: "1", name: "greet", args: {} }] } }
          : { wantsToolCalls: false, message: { role: "assistant", content: "hi" } };
      },
    };
    const agent = new Agent({ platform: fakePlatform(), llm, tools: [greet] });
    await agent.run("greet");
    expect(called).toBe(true);
  });

  it("skips a confirm-required tool when the user declines", async () => {
    let step = 0;
    const llm: LlmClient = {
      id: "f",
      complete: async (): Promise<CompletionResult> => {
        step++;
        return step === 1
          ? { wantsToolCalls: true, message: { role: "assistant", content: "", toolCalls: [{ id: "1", name: "launch_app", args: { appId: "netflix" } }] } }
          : { wantsToolCalls: false, message: { role: "assistant", content: "okay, cancelled" } };
      },
    };
    const platform = fakePlatform();
    let launched = false;
    platform.apps.launchApp = async () => { launched = true; };
    const results: unknown[] = [];
    const agent = new Agent({ platform, llm, confirm: () => false });
    agent.events.on("tool:result", (e) => results.push(e.result));
    await agent.run("open netflix");
    expect(launched).toBe(false);
    expect(results[0]).toMatchObject({ declined: true });
  });

  it("runs a confirm-required tool when approved", async () => {
    let step = 0;
    const llm: LlmClient = {
      id: "f",
      complete: async (): Promise<CompletionResult> => {
        step++;
        return step === 1
          ? { wantsToolCalls: true, message: { role: "assistant", content: "", toolCalls: [{ id: "1", name: "launch_app", args: { appId: "netflix" } }] } }
          : { wantsToolCalls: false, message: { role: "assistant", content: "launched" } };
      },
    };
    const platform = fakePlatform();
    let launched = false;
    platform.apps.launchApp = async () => { launched = true; };
    const agent = new Agent({ platform, llm, confirm: async () => true });
    await agent.run("open netflix");
    expect(launched).toBe(true);
  });

  it("exposes a built-in help tool listing capabilities", async () => {
    const agent = new Agent({ platform: fakePlatform(), llm: finalLlm });
    expect(agent.toolRegistry.has("help")).toBe(true);
    const list = (await agent.toolRegistry.call("help", {})) as Array<{ name: string }>;
    const names = list.map((t) => t.name);
    expect(names).toContain("set_volume");
    expect(names).not.toContain("help");
  });

  it("restores history in a brand-new adapter — i.e. across an app restart", async () => {
    // The original bug: every adapter backed platform.storage with an in-memory
    // Map, so `persistKey` was a no-op on real devices. A test that reuses one
    // adapter instance can't see that; this one builds a second adapter, which
    // is what happens when the app is relaunched.
    const data = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
    };
    try {
      const before = new Agent({ platform: createWebAdapter(), llm: finalLlm, persistKey: "sess-restart" });
      await before.run("remember this");
      expect(before.historyLength).toBeGreaterThan(0);

      const afterRestart = new Agent({ platform: createWebAdapter(), llm: finalLlm, persistKey: "sess-restart" });
      expect(afterRestart.historyLength).toBe(0);
      expect(await afterRestart.restore()).toBe(true);
      expect(afterRestart.historyLength).toBe(before.historyLength);
    } finally {
      delete (globalThis as any).localStorage;
    }
  });

  it("persists history and restores it in a new agent sharing storage", async () => {
    const platform = createWebAdapter(); // shared in-memory storage
    const a1 = new Agent({ platform, llm: finalLlm, persistKey: "sess-1" });
    await a1.run("hello");
    await a1.run("again");
    expect(a1.historyLength).toBeGreaterThan(0);

    const a2 = new Agent({ platform, llm: finalLlm, persistKey: "sess-1" });
    expect(a2.historyLength).toBe(0);
    expect(await a2.restore()).toBe(true);
    expect(a2.historyLength).toBe(a1.historyLength);

    a2.reset();
    const a3 = new Agent({ platform, llm: finalLlm, persistKey: "sess-1" });
    expect(await a3.restore()).toBe(false); // cleared
  });
});

describe("only offering what the device can do", () => {
  /**
   * `has()` answers a structural question — is there a `system` object — and
   * `system` exists on every adapter, so the volume tools were always
   * registered. On the Tizen emulator the agent said "I can set volume, mute,
   * switch input, or open an app" and then declined every audio request,
   * because that build has no audio API. It promised, then refused.
   */
  const noAudio = (): PlatformProvider => {
    const p = fakePlatform();
    const refuse = () => { throw new TvUnsupportedError("no audio control API on this build"); };
    return { ...p, system: { ...p.system, getVolume: refuse, getMute: refuse, setVolume: refuse, setMute: refuse } };
  };

  const names = (agent: Agent) => agent.toolRegistry.list().map((s) => s.name);

  it("withdraws the audio tools at boot when the read says unsupported", async () => {
    const agent = new Agent({ platform: noAudio(), llm: finalLlm });
    expect(names(agent)).toContain("set_volume");   // before probing
    const probe = await agent.probeCapabilities();
    // The probe withdraws *capabilities*; the tools follow from them.
    expect(probe.withdrawn.sort()).toEqual([
      "tv.audio.get_mute", "tv.audio.get_volume", "tv.audio.set_mute", "tv.audio.set_volume",
    ]);
    expect(probe.tools.sort()).toEqual(["get_mute", "get_volume", "set_mute", "set_volume"]);
    expect(agent.capabilities.get("tv.audio.set_volume")?.status).toBe("withdrawn");
    expect(names(agent)).not.toContain("set_volume");
    expect(names(agent)).not.toContain("get_mute");
  });

  it("keeps everything the device can still do", async () => {
    const agent = new Agent({ platform: noAudio(), llm: finalLlm });
    await agent.probeCapabilities();
    // The point is a shorter honest list, not a broken one.
    expect(names(agent)).toContain("launch_app");
    expect(names(agent)).toContain("press_key");
    expect(names(agent)).toContain("help");
  });

  it("never withdraws help — a device with nothing left must still say so", async () => {
    const p = fakePlatform();
    const refuse = () => { throw new TvUnsupportedError("nothing works here"); };
    const agent = new Agent({
      platform: {
        ...p,
        system: { ...p.system, getVolume: refuse, getMute: refuse, getInputSource: refuse },
        apps: { ...p.apps, listInstalledApps: refuse },
      },
      llm: finalLlm,
    });
    await agent.probeCapabilities();
    expect(names(agent)).toContain("help");
  });

  it("leaves a tool alone when the read merely failed", async () => {
    // A bad moment is not a missing capability. Withdrawing over one would
    // disable a working TV on a single hiccup.
    const p = fakePlatform();
    const agent = new Agent({
      platform: { ...p, system: { ...p.system, getVolume: async () => { throw new Error("read timed out"); } } },
      llm: finalLlm,
    });
    const probe = await agent.probeCapabilities();
    expect(probe.withdrawn).toEqual([]);
    expect(names(agent)).toContain("set_volume");
  });

  it("reports why, so ?diag doesn't just say 'gone'", async () => {
    const agent = new Agent({ platform: noAudio(), llm: finalLlm });
    const events: Array<{ name: string; reason: string; at: string }> = [];
    agent.events.on("tool:withdrawn", (e) => events.push(e));
    const probe = await agent.probeCapabilities();
    expect(probe.notes.join(" ")).toMatch(/no audio control API/);
    expect(events.every((e) => e.at === "probe")).toBe(true);
    expect(events.find((e) => e.name === "set_volume")?.reason).toMatch(/no audio control API/);
    // And the reason is attached to the capability, not reconstructed from the
    // tool's name — which is what `reasonFor(name.includes("volume"))` was doing.
    expect(probe.reasons["tv.audio.set_volume"]).toMatch(/no audio control API/);
  });

  it("withdraws a write-only tool the first time it refuses", async () => {
    // `set_input_source` has no side-effect-free read, so the boot probe cannot
    // reach it — doing it *is* the probe. This is the backstop that covers it,
    // and an API that only appears after boot.
    const p = fakePlatform();
    const platform: PlatformProvider = {
      ...p,
      system: {
        ...p.system,
        setInputSource: () => { throw new TvUnsupportedError("setInputSource on this firmware"); },
      },
    };
    let step = 0;
    const llm: LlmClient = {
      id: "one-call",
      complete: async (): Promise<CompletionResult> => (step++ === 0
        ? {
          wantsToolCalls: true,
          message: {
            role: "assistant", content: "",
            toolCalls: [{ id: "c1", name: "set_input_source", args: { source: "hdmi2" } }],
          },
        }
        : { wantsToolCalls: false, message: { role: "assistant", content: "can't" } }),
    };
    const agent = new Agent({ platform, llm, unattended: true });
    const withdrawn: string[] = [];
    agent.events.on("tool:withdrawn", (e) => withdrawn.push(`${e.name}@${e.at}`));
    const byCall: string[] = [];
    agent.events.on("tool:withdrawn", (e) => { if (e.capability) byCall.push(e.capability); });

    expect(agent.toolRegistry.list().map((s) => s.name)).toContain("set_input_source");
    await agent.run("switch to hdmi2");
    expect(withdrawn).toEqual(["set_input_source@call"]);
    expect(byCall).toEqual(["tv.input.switch"]);
    // The write is gone; the read it was never able to vouch for is untouched.
    expect(agent.capabilities.get("tv.input.switch")?.status).toBe("withdrawn");
    expect(agent.capabilities.get("tv.input.get_source")?.status).toBe("available");
    expect(agent.toolRegistry.list().map((s) => s.name)).not.toContain("set_input_source");
    expect(agent.toolRegistry.list().map((s) => s.name)).toContain("get_input_source");
  });

  it("still tells the model about the refusal on the turn it happened", async () => {
    // Withdrawing must not swallow the result: the model needs it to explain.
    const p = fakePlatform();
    const platform: PlatformProvider = {
      ...p,
      system: {
        ...p.system,
        setInputSource: () => { throw new TvUnsupportedError("setInputSource on this firmware"); },
      },
    };
    let step = 0;
    const seen: unknown[] = [];
    const llm: LlmClient = {
      id: "one-call",
      complete: async (req): Promise<CompletionResult> => {
        seen.push(req.messages.filter((m) => m.role === "tool").map((m) => m.content));
        return step++ === 0
          ? {
            wantsToolCalls: true,
            message: {
              role: "assistant", content: "",
              toolCalls: [{ id: "c1", name: "set_input_source", args: { source: "hdmi2" } }],
            },
          }
          : { wantsToolCalls: false, message: { role: "assistant", content: "no" } };
      },
    };
    await new Agent({ platform, llm, unattended: true }).run("switch to hdmi2");
    expect(JSON.stringify(seen)).toMatch(/unsupported/);
  });
});

/**
 * The agent used to know only what it had *said*. A `set_volume` turn left no
 * trace anywhere except chat history, which is trimmed at twelve messages, so
 * "a bit quieter" meant asking the TV again what quieter was.
 */
describe("Agent — what it knows about the room", () => {
  /** An LLM that calls one tool, and records the prompt it was given. */
  function recordingLlm(call: { name: string; args: Record<string, unknown> }) {
    const prompts: string[] = [];
    let step = 0;
    const llm: LlmClient = {
      id: "recorder",
      complete: async (req): Promise<CompletionResult> => {
        prompts.push(String(req.messages[0]?.content ?? ""));
        step++;
        return step === 1
          ? { wantsToolCalls: true, message: { role: "assistant", content: "", toolCalls: [{ id: "1", ...call }] } }
          : { wantsToolCalls: false, message: { role: "assistant", content: "done" } };
      },
    };
    return { llm, prompts };
  }

  it("learns the volume from the tool it just called", async () => {
    const { llm } = recordingLlm({ name: "set_volume", args: { level: 25 } });
    const agent = new Agent({ platform: fakePlatform(), llm });
    await agent.run("set volume to 25");
    expect(agent.world.value("tv.volume")).toBe(25);
    expect(agent.world.get("tv.volume")?.source).toBe("tool");
  });

  it("learns both facts a single read reports", async () => {
    const { llm } = recordingLlm({ name: "get_volume", args: {} });
    const agent = new Agent({ platform: fakePlatform(), llm });
    await agent.run("what's the volume?");
    expect(agent.world.value("tv.volume")).toBe(10);
    expect(agent.world.value("tv.muted")).toBe(false);
  });

  it("tells the model what it already knows, and only that", async () => {
    const { llm, prompts } = recordingLlm({ name: "set_volume", args: { level: 25 } });
    const agent = new Agent({ platform: fakePlatform(), llm });

    await agent.run("set volume to 25");
    // Nothing was known when the turn opened, so nothing was claimed.
    expect(prompts[0]).not.toContain("What you already know");
    // By the second round of the same turn, the tool result is in the world.
    expect(prompts[1]).toContain("tv.volume: 25");
    expect(prompts[1]).not.toContain("unknown");
  });

  it("can be told not to put it in the prompt, and still keeps the facts", async () => {
    const { llm, prompts } = recordingLlm({ name: "set_volume", args: { level: 25 } });
    const agent = new Agent({ platform: fakePlatform(), llm, worldInPrompt: false });
    await agent.run("set volume to 25");
    expect(prompts[1]).not.toContain("What you already know");
    expect(agent.world.value("tv.volume")).toBe(25);
  });

  it("keeps the block within its budget", async () => {
    const { llm, prompts } = recordingLlm({ name: "list_apps", args: {} });
    const agent = new Agent({ platform: fakePlatform(), llm, worldPromptChars: 40 });
    await agent.run("what can I watch?");
    const base = prompts[0]!.length;
    // The whole point of a budget is that the prompt cannot grow with the room.
    expect(prompts[1]!.length - base).toBeLessThan(160);
  });

  it("says nothing about a tool it has no capability for", async () => {
    const greet = defineTool({ name: "greet", description: "greet", parameters: {} }, async () => ({ hi: true }));
    const { llm } = recordingLlm({ name: "greet", args: {} });
    const agent = new Agent({ platform: fakePlatform(), llm, tools: [greet] });
    await agent.run("hello");
    expect(agent.world.paths()).toEqual([]);
  });
});

/**
 * One gate for both paths. It used to be a boolean on the tool spec, checked
 * inside the chat loop, which meant a plan step and a chat tool call could
 * disagree about the same action — and only one of them could ever be given a
 * parental rule or an enterprise policy.
 */
describe("Agent — one policy gate", () => {
  const callOnce = (name: string, args: Record<string, unknown> = {}): LlmClient => {
    let step = 0;
    return {
      id: "one-call",
      complete: async (): Promise<CompletionResult> => (step++ === 0
        ? { wantsToolCalls: true, message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name, args }] } }
        : { wantsToolCalls: false, message: { role: "assistant", content: "done" } }),
    };
  };

  it("declines a disruptive tool when there is nobody to ask", async () => {
    const agent = new Agent({ platform: fakePlatform(), llm: callOnce("launch_app", { appId: "netflix" }) });
    const results: unknown[] = [];
    agent.events.on("tool:result", (e) => results.push(e.result));
    await agent.run("open netflix");
    expect(JSON.stringify(results)).toMatch(/needs confirmation, and nothing can ask/);
  });

  it("runs it when the host says nobody is watching", async () => {
    const platform = fakePlatform();
    const agent = new Agent({ platform, llm: callOnce("launch_app", { appId: "netflix" }), unattended: true });
    const results: unknown[] = [];
    agent.events.on("tool:result", (e) => results.push(e.result));
    await agent.run("open netflix");
    expect(JSON.stringify(results)).not.toMatch(/needs confirmation/);
  });

  it("holds a custom tool to the same rule, rather than leaving a hole", async () => {
    let ran = false;
    const buy = defineTool(
      { name: "buy", description: "Buy the thing", parameters: {}, confirm: true },
      async () => { ran = true; return { ok: true }; },
    );
    const asked: string[] = [];
    const agent = new Agent({
      platform: fakePlatform(),
      llm: callOnce("buy"),
      tools: [buy],
      confirm: (req) => { asked.push(req.name); return false; },
    });
    await agent.run("buy it");
    expect(asked).toEqual(["buy"]);
    expect(ran).toBe(false);
  });

  it("lets a profile rule deny outright, and tells the model why", async () => {
    const policy = new PolicyEngine([...defaultRules(), ...parentalRules({ maxVolume: 30 })]);
    const agent = new Agent({
      platform: fakePlatform(),
      llm: callOnce("set_volume", { level: 80 }),
      policy,
      confirm: () => true,
    });
    const results: unknown[] = [];
    agent.events.on("tool:result", (e) => results.push(e.result));
    await agent.run("crank it");
    expect(JSON.stringify(results)).toMatch(/capped at 30/);
  });

  it("records every decision, from either path", async () => {
    const platform = fakePlatform();
    const agent = new Agent({ platform, llm: callOnce("set_volume", { level: 40 }), confirm: () => true });
    const audit: string[] = [];
    agent.events.on("policy:decision", ({ entry }) => audit.push(`${entry.capabilityId}:${entry.decision.effect}`));

    await agent.run("volume 40");
    expect(audit).toContain("tv.audio.set_volume:allow");

    await agent.pursue({ id: "g", desiredState: [{ path: "tv.volume", equals: 12 }] });
    expect(audit.filter((a) => a === "tv.audio.set_volume:allow")).toHaveLength(2);
  });
});
