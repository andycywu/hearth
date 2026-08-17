import { describe, it, expect } from "vitest";
import { Agent } from "./agent.js";
import { defineTool } from "../tools/registry.js";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import type { LlmClient, CompletionResult } from "../llm/client.js";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import { TvUnsupportedError } from "@tv-ai-agent/platform-api";

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
    expect(probe.withdrawn.sort()).toEqual(["get_mute", "get_volume", "set_mute", "set_volume"]);
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
    const agent = new Agent({ platform, llm });
    const withdrawn: string[] = [];
    agent.events.on("tool:withdrawn", (e) => withdrawn.push(`${e.name}@${e.at}`));

    expect(agent.toolRegistry.list().map((s) => s.name)).toContain("set_input_source");
    await agent.run("switch to hdmi2");
    expect(withdrawn).toEqual(["set_input_source@call"]);
    expect(agent.toolRegistry.list().map((s) => s.name)).not.toContain("set_input_source");
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
    await new Agent({ platform, llm }).run("switch to hdmi2");
    expect(JSON.stringify(seen)).toMatch(/unsupported/);
  });
});
