import { describe, it, expect } from "vitest";
import { Agent } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createScriptedClient } from "@hearthkit/llm-connectors";
import { TvUnsupportedError, type InputSource, type ScreenLayout } from "@hearthkit/platform-api";
import { loadTvModule, withTv, type TvModule } from "./tv-module.js";
import { answer } from "./voice-loop.js";

/**
 * A television on the far side of the network, as a module would describe it: its own volume, its own inputs, a
 * picture that can be moved. The box underneath is the in-memory adapter standing in for the Pi.
 */
function farTv(start: { volume?: number; input?: InputSource } = {}) {
  let volume = start.volume ?? 20;
  let input: InputSource = start.input ?? "app";
  let layout: ScreenLayout | undefined = "fullscreen";
  const calls: string[] = [];
  const tv: TvModule = {
    name: "far tv",
    system: {
      getVolume: async () => volume,
      setVolume: async (level) => { calls.push(`setVolume ${level}`); volume = level; },
      getInputSource: async () => input,
      setInputSource: async (source) => { calls.push(`setInputSource ${source}`); input = source; },
    },
    display: {
      getLayout: async () => layout,
      setLayout: async (next) => { calls.push(`setLayout ${next}`); layout = next; },
    },
    init: async () => { calls.push("init"); },
  };
  return { tv, calls };
}

describe("withTv", () => {
  it("takes the TV's controls where it has them and leaves the box's where it does not", async () => {
    const box = createWebAdapter();
    await box.system.setMute(true);
    const { tv, calls } = farTv({ volume: 33 });
    const platform = withTv(box, tv);
    await platform.init();

    expect(calls).toEqual(["init"]);
    expect(await platform.system.getVolume()).toBe(33);
    await platform.system.setVolume(10);
    expect(calls).toContain("setVolume 10");
    // Not in the module: still the box's own answer.
    expect(await platform.system.getMute()).toBe(true);
  });

  it("puts the TV's picture in the display slot, and keeps the box's when the module has none", async () => {
    const box = createWebAdapter();
    const { tv, calls } = farTv();
    const platform = withTv(box, tv);
    expect(platform.has("display")).toBe(true);
    await platform.display!.setLayout("panel");
    expect(calls).toContain("setLayout panel");
    expect(await box.display!.getLayout()).not.toBe("panel");

    expect(withTv(box, {}).display).toBe(box.display);
  });

  it("leaves a member the module did not give to the box, rather than inventing a TV answer", async () => {
    const box = createWebAdapter();
    await box.system.setInputSource("hdmi2");
    const platform = withTv(box, { system: {} });
    expect(await platform.system.getInputSource()).toBe("hdmi2");
  });

  it("lets a module refuse in the typed way the rest of the stack understands", async () => {
    const platform = withTv(createWebAdapter(), {
      system: { powerStandby: async () => { throw new TvUnsupportedError("standby is not offered on this set"); } },
    });
    await expect(platform.system.powerStandby()).rejects.toBeInstanceOf(TvUnsupportedError);
  });

  it("drives the far TV end to end: 'turn it down' lowers the TV's volume, not the box's", async () => {
    const box = createWebAdapter();
    await box.system.setVolume(70);
    const { tv, calls } = farTv({ volume: 40 });
    const platform = withTv(box, tv);
    await platform.init();
    const agent = new Agent({ platform, llm: createScriptedClient(), confirm: async () => true });
    await agent.probeCapabilities();

    await answer(agent, "turn it down");
    expect(calls.some((c) => c.startsWith("setVolume"))).toBe(true);
    expect(await platform.system.getVolume()).toBeLessThan(40);
    expect(await box.system.getVolume()).toBe(70);
  });
});

describe("loadTvModule", () => {
  it("builds the TV from createTv(env)", async () => {
    let seen: Record<string, string | undefined> | undefined;
    const tv = await loadTvModule("tv.mjs", { TV_HOST: "10.0.0.2" }, async () => ({
      createTv: (env: Record<string, string | undefined>) => { seen = env; return { name: `tv @ ${env.TV_HOST}` }; },
    }));
    expect(tv.name).toBe("tv @ 10.0.0.2");
    expect(seen?.TV_HOST).toBe("10.0.0.2");
  });

  it("accepts a default export", async () => {
    const tv = await loadTvModule("tv.mjs", {}, async () => ({ default: () => ({ name: "default" }) }));
    expect(tv.name).toBe("default");
  });

  it("says what is wrong with a module that exports neither", async () => {
    await expect(loadTvModule("nothing.mjs", {}, async () => ({ other: 1 }))).rejects.toThrow(/createTv/);
  });

  it("resolves the path from the working directory into a file URL", async () => {
    let url = "";
    await loadTvModule("private/tv.mjs", {}, async (u) => { url = u; return { createTv: () => ({}) }; });
    expect(url.startsWith("file://")).toBe(true);
    expect(url.endsWith("/private/tv.mjs")).toBe(true);
  });
});
