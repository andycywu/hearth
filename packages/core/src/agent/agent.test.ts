import { describe, it, expect } from "vitest";
import { Agent } from "./agent.js";
import { defineTool } from "../tools/registry.js";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import type { LlmClient, CompletionResult } from "../llm/client.js";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";

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
