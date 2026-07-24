import { describe, it, expect } from "vitest";
import { Agent } from "./agent.js";
import type { LlmClient, CompletionResult } from "../llm/client.js";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";

function fakePlatform(): PlatformProvider {
  let volume = 10;
  return {
    device: { os: "web", osVersion: "0", soc: "unknown", model: "test", capabilities: {} },
    system: {
      getVolume: async () => volume,
      setVolume: async (v) => { volume = v; },
      setMute: async () => {},
      getInputSource: async () => "tv",
      setInputSource: async () => {},
      powerStandby: async () => {},
    },
    apps: {
      listInstalledApps: async () => [{ id: "netflix", name: "Netflix" }],
      launchApp: async () => {},
      getForegroundApp: async () => null,
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
});
