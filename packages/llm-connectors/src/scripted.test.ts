import { describe, it, expect } from "vitest";
import { Agent, defineTool, type Tool } from "@tv-ai-agent/core";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import { createScriptedClient } from "./scripted.js";

function makeAgent(tools: Tool[] = []) {
  const platform = createWebAdapter();
  const llm = createScriptedClient();
  return { platform, agent: new Agent({ platform, llm, tools }) };
}

/** Stand-in for the example skill in packages/skills-example (no network). */
function fakeWeatherTool(calls: Array<Record<string, unknown>>): Tool {
  return defineTool(
    {
      name: "get_weather",
      description: "Current weather for a city.",
      parameters: { city: { type: "string", description: "City", required: true } },
    },
    async (args) => {
      calls.push(args);
      return { city: String(args.city), tempC: 21.3, summary: "Light rain" };
    },
  ) as Tool;
}

/** Stand-in for examples/open-meteo-weather.json — coordinates, not a city. */
function fakeManifestWeatherTool(calls: Array<Record<string, unknown>>): Tool {
  return defineTool(
    {
      name: "get_current_weather",
      description: "Current temperature at a latitude/longitude.",
      parameters: {
        latitude: { type: "number", description: "Decimal degrees", required: true },
        longitude: { type: "number", description: "Decimal degrees", required: true },
      },
    },
    async (args) => {
      calls.push(args);
      return { temperatureC: 21.3 };
    },
  ) as Tool;
}

describe("scripted client — full agent loop (offline)", () => {
  it("sets volume from a natural-language request", async () => {
    const { platform, agent } = makeAgent();
    const out = await agent.run("set volume to 30");
    expect(await platform.system.getVolume()).toBe(30);
    expect(out).toMatch(/done/i);
  });

  it("reads volume back", async () => {
    const { agent } = makeAgent();
    await agent.run("set volume to 42");
    const out = await agent.run("what's the volume?");
    expect(out).toContain("42");
  });

  it("opens an app via search then launch (multi-step)", async () => {
    const { agent } = makeAgent();
    const events: string[] = [];
    agent.events.on("tool:call", (e) => events.push(e.name));
    const out = await agent.run("open Netflix");
    expect(events).toEqual(["search_app_by_name", "launch_app"]);
    expect(out).toMatch(/done/i);
  });

  it("streams the final answer token-by-token", async () => {
    const { agent } = makeAgent();
    const tokens: string[] = [];
    agent.events.on("token", (e) => tokens.push(e.delta));
    await agent.run("set volume to 10");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join("")).toMatch(/done/i);
  });

  it("mutes on request", async () => {
    const { platform, agent } = makeAgent();
    await agent.run("mute");
    expect(await platform.system.getMute()).toBe(true);
  });

  it("handles relative volume (louder): reads then adjusts (+10)", async () => {
    const { platform, agent } = makeAgent();
    await agent.run("set volume to 50");
    const tools: string[] = [];
    agent.events.on("tool:call", (e) => tools.push(e.name));
    await agent.run("make it louder");
    expect(tools).toEqual(["get_volume", "set_volume"]);
    expect(await platform.system.getVolume()).toBe(60);
  });

  it("handles relative volume (quieter): reads then adjusts (-10)", async () => {
    const { platform, agent } = makeAgent();
    await agent.run("set volume to 50");
    await agent.run("turn it down");
    expect(await platform.system.getVolume()).toBe(40);
  });

  it("replies in Chinese when the user writes Chinese", async () => {
    const { platform, agent } = makeAgent();
    const out = await agent.run("音量調到 30");
    expect(await platform.system.getVolume()).toBe(30);
    expect(out).toContain("完成");
  });

  it("reads volume back in Chinese", async () => {
    const { agent } = makeAgent();
    await agent.run("set volume to 42");
    const out = await agent.run("現在音量多少?");
    expect(out).toContain("42");
    expect(out).toMatch(/音量/);
  });

  it("only proposes a custom skill's tool when the host registered it", async () => {
    // Without the skill, a weather question must fall through to the help text
    // rather than calling a tool that doesn't exist.
    const { agent } = makeAgent();
    const tools: string[] = [];
    agent.events.on("tool:call", (e) => tools.push(e.name));
    const out = await agent.run("what's the weather in Taipei?");
    expect(tools).toEqual([]);
    expect(out).toMatch(/I can set volume/);
  });

  it("calls a registered custom skill and renders its result", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { agent } = makeAgent([fakeWeatherTool(calls)]);
    const out = await agent.run("what's the weather in Taipei?");
    expect(calls).toEqual([{ city: "Taipei" }]);
    expect(out).toBe("Taipei: 21.3°C, light rain.");
  });

  it("understands a Chinese weather question", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { agent } = makeAgent([fakeWeatherTool(calls)]);
    const out = await agent.run("台北天氣如何?");
    expect(calls).toEqual([{ city: "台北" }]);
    expect(out).toContain("21.3°C");
  });

  it("calls the manifest weather skill with coordinates instead", async () => {
    // Same question, the declarative version of the skill. A manifest makes one
    // request, so it takes lat/lon rather than a city name.
    const calls: Array<Record<string, unknown>> = [];
    const { agent } = makeAgent([fakeManifestWeatherTool(calls)]);
    await agent.run("what's the weather in Taipei?");
    expect(calls).toEqual([{ latitude: 25.03, longitude: 121.57 }]);
  });

  it("says why it can't, rather than guessing coordinates", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { agent } = makeAgent([fakeManifestWeatherTool(calls)]);
    const out = await agent.run("what's the weather in Reykjavik?");
    expect(calls).toEqual([]);
    expect(out).toMatch(/only knows coordinates for a few demo cities/);
  });

  it("doesn't mistake a time word for a city", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { agent } = makeAgent([fakeWeatherTool(calls)]);
    await agent.run("what's the weather today?");
    await agent.run("現在天氣如何?");
    expect(calls).toEqual([]);
  });

  describe("Japanese", () => {
    it("sets the volume and replies in Japanese", async () => {
      const { platform, agent } = makeAgent();
      const out = await agent.run("音量を30にして");
      expect(await platform.system.getVolume()).toBe(30);
      expect(out).toBe("完了しました。");
    });

    it("reads the volume back in Japanese", async () => {
      const { agent } = makeAgent();
      await agent.run("set volume to 42");
      const out = await agent.run("音量はいくつですか?");
      expect(out).toBe("現在の音量は 42 です。");
    });

    it("handles relative volume (大きく / 小さく)", async () => {
      const { platform, agent } = makeAgent();
      await agent.run("set volume to 50");
      await agent.run("音量を大きくして");
      expect(await platform.system.getVolume()).toBe(60);
      await agent.run("音量を小さくして");
      expect(await platform.system.getVolume()).toBe(50);
    });

    it("mutes and unmutes, not confusing 解除 for a mute request", async () => {
      // A successful action reports "done" rather than echoing its readback, so
      // what matters here is the device state, in both directions.
      const { platform, agent } = makeAgent();
      expect(await agent.run("ミュートして")).toBe("完了しました。");
      expect(await platform.system.getMute()).toBe(true);
      expect(await agent.run("ミュートを解除して")).toBe("完了しました。");
      expect(await platform.system.getMute()).toBe(false);
    });

    it("opens an app despite the verb coming last", async () => {
      const { agent } = makeAgent();
      const tools: string[] = [];
      agent.events.on("tool:call", (e) => tools.push(e.name));
      const out = await agent.run("Netflix を開いて");
      expect(tools).toEqual(["search_app_by_name", "launch_app"]);
      expect(out).toBe("完了しました。");
    });

    it("falls back to Japanese help text for anything it can't parse", async () => {
      const { agent } = makeAgent();
      const out = await agent.run("ちょっと何かしてくれる?");
      expect(out).toContain("音量調整");
    });

    it("answers a Japanese weather question via the skill", async () => {
      const calls: Array<Record<string, unknown>> = [];
      const { agent } = makeAgent([fakeWeatherTool(calls)]);
      const out = await agent.run("東京の天気は?");
      expect(calls).toEqual([{ city: "東京" }]);
      expect(out).toBe("東京は 21.3°C、Light rain。");
    });

    it("still answers Chinese in Chinese (Han-only text isn't misread as ja)", async () => {
      const { agent } = makeAgent();
      expect(await agent.run("音量調到 30")).toBe("完成。");
    });
  });

  it("resolves 'it' to the last launched app (coreference across turns)", async () => {
    const { agent } = makeAgent();
    await agent.run("open Netflix");
    const tools: Array<{ name: string; args: any }> = [];
    agent.events.on("tool:call", (e) => tools.push({ name: e.name, args: e.args }));
    await agent.run("launch it again");
    const launch = tools.find((t) => t.name === "launch_app");
    expect(launch?.args).toMatchObject({ appId: "com.netflix.ninja" });
  });
});

describe("asking about mute rather than commanding it", () => {
  /**
   * "靜音了嗎" contains the mute word, so it was obeyed as an order and the
   * question *changed* the thing it asked about. Caught on the Android TV
   * emulator: the reply was "完成。" and the TV went silent.
   *
   * English survived only by luck — `\bmute\b` doesn't match "muted" — which is
   * exactly the kind of accident that hides a bug in the other languages.
   */
  const ask = async (text: string) => {
    const { platform, agent } = makeAgent();
    const tools: string[] = [];
    agent.events.on("tool:call", (e) => tools.push(e.name));
    const output = await agent.run(text);
    return { tools, output, muted: await platform.system.getMute() };
  };

  it("answers a Chinese question without muting the TV", async () => {
    const { tools, muted } = await ask("靜音了嗎");
    expect(tools).toEqual(["get_mute"]);
    expect(muted, "asking must not change the state").toBe(false);
  });

  it("handles the other ways of asking", async () => {
    for (const q of ["有沒有靜音", "靜音了沒有", "是不是靜音了?"]) {
      expect((await ask(q)).tools, q).toEqual(["get_mute"]);
    }
  });

  it("answers in English and Japanese too", async () => {
    expect((await ask("is it muted?")).tools).toEqual(["get_mute"]);
    expect((await ask("ミュートですか")).tools).toEqual(["get_mute"]);
  });

  it("answers the question rather than reporting an action", async () => {
    // "Unmuted." to "is it muted?" reads as "I have just unmuted it" — the
    // agent claiming to have done something it was only asked about.
    const { output } = await ask("is it muted?");
    expect(output).toMatch(/isn't muted|is muted/);
    expect(output).not.toBe("Unmuted.");
  });

  it("still performs the action when it was an action", async () => {
    // Mutations answer "Done." — the envelope carries success, so there is no
    // readback to narrate. What matters is that the TV actually changed.
    const { platform, agent } = makeAgent();
    expect(await agent.run("mute")).toBe("Done.");
    expect(await platform.system.getMute()).toBe(true);
  });

  it("still obeys a plain command", async () => {
    expect((await ask("靜音")).tools).toEqual(["set_mute"]);
    expect((await ask("mute")).tools).toEqual(["set_mute"]);
    expect((await ask("取消靜音")).tools).toEqual(["set_mute"]);
  });
});
