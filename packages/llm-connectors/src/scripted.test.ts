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

  it("doesn't mistake a time word for a city", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { agent } = makeAgent([fakeWeatherTool(calls)]);
    await agent.run("what's the weather today?");
    await agent.run("現在天氣如何?");
    expect(calls).toEqual([]);
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
