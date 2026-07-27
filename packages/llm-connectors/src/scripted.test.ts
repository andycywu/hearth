import { describe, it, expect } from "vitest";
import { Agent } from "@tv-ai-agent/core";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import { createScriptedClient } from "./scripted.js";

function makeAgent() {
  const platform = createWebAdapter();
  const llm = createScriptedClient();
  return { platform, agent: new Agent({ platform, llm }) };
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
});
