import { describe, it, expect } from "vitest";
import { createTvTools } from "./tv-tools.js";
import type { Tool } from "./registry.js";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";

/** Records every HAL call so a tool can be checked against the platform. */
interface Calls {
  setVolume: number[];
  setMute: boolean[];
  setInputSource: string[];
  launchApp: string[];
  sendKey: string[];
  play: string[];
  pause: number;
  resume: number;
  seek: number[];
}

function fakePlatform(opts: { media?: boolean } = {}): { platform: PlatformProvider; calls: Calls } {
  const withMedia = opts.media ?? true;
  const calls: Calls = {
    setVolume: [], setMute: [], setInputSource: [], launchApp: [], sendKey: [],
    play: [], pause: 0, resume: 0, seek: [],
  };
  const state = { volume: 20, muted: false, input: "tv" as const };
  const apps = [
    { id: "com.netflix.ninja", name: "Netflix" },
    { id: "com.google.android.youtube.tv", name: "YouTube" },
  ];

  const provider: PlatformProvider = {
    device: { os: "web", osVersion: "0", soc: "unknown", model: "test", capabilities: {} },
    system: {
      getVolume: async () => state.volume,
      setVolume: async (v) => { calls.setVolume.push(v); state.volume = v; },
      getMute: async () => state.muted,
      setMute: async (m) => { calls.setMute.push(m); state.muted = m; },
      getInputSource: async () => state.input,
      setInputSource: async (s) => { calls.setInputSource.push(s); },
      powerStandby: async () => {},
    },
    apps: {
      listInstalledApps: async () => apps,
      launchApp: async (id) => { calls.launchApp.push(id); },
      getForegroundApp: async () => null,
      findAppsByName: async (q) =>
        apps.filter((a) => a.name.toLowerCase().includes(q.toLowerCase())),
    },
    navigation: { sendKey: async (k) => { calls.sendKey.push(k); } },
    network: { isOnline: async () => true, connectionType: async () => "ethernet" },
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    ...(withMedia
      ? {
          media: {
            play: async (uri: string) => { calls.play.push(uri); },
            pause: async () => { calls.pause++; },
            resume: async () => { calls.resume++; },
            seek: async (ms: number) => { calls.seek.push(ms); },
          },
        }
      : {}),
    // Same rule the real adapters use: a capability exists if the slot is filled.
    has: (cap) => cap in provider && (provider as any)[cap] !== undefined,
    init: async () => {},
  };
  return { platform: provider, calls };
}

const byName = (tools: Tool[], name: string): Tool => {
  const tool = tools.find((t) => t.spec.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
};

describe("createTvTools — system", () => {
  it("reads and writes the volume through the HAL", async () => {
    const { platform, calls } = fakePlatform();
    const tools = createTvTools(platform);
    expect(await byName(tools, "get_volume").execute({})).toEqual({ volume: 20 });
    expect(await byName(tools, "set_volume").execute({ level: 35 })).toEqual({ ok: true, volume: 35 });
    expect(calls.setVolume).toEqual([35]);
  });

  it("coerces a string level to a number (models often send strings)", async () => {
    const { platform, calls } = fakePlatform();
    await byName(createTvTools(platform), "set_volume").execute({ level: "40" });
    expect(calls.setVolume).toEqual([40]);
  });

  it("mutes and reports the resulting state", async () => {
    const { platform, calls } = fakePlatform();
    const tools = createTvTools(platform);
    expect(await byName(tools, "set_mute").execute({ mute: true })).toEqual({ ok: true, muted: true });
    expect(await byName(tools, "set_mute").execute({ mute: false })).toEqual({ ok: true, muted: false });
    expect(calls.setMute).toEqual([true, false]);
  });

  it("reads and switches the input source", async () => {
    const { platform, calls } = fakePlatform();
    const tools = createTvTools(platform);
    expect(await byName(tools, "get_input_source").execute({})).toEqual({ source: "tv" });
    expect(await byName(tools, "set_input_source").execute({ source: "hdmi2" })).toEqual({ ok: true });
    expect(calls.setInputSource).toEqual(["hdmi2"]);
  });

  it("offers the input sources and remote keys as enums so the model can't invent one", () => {
    const tools = createTvTools(fakePlatform().platform);
    expect(byName(tools, "set_input_source").spec.parameters.source?.enum).toContain("hdmi1");
    expect(byName(tools, "press_key").spec.parameters.key?.enum).toContain("playpause");
  });

  it("gates the high-impact tools behind confirmation", () => {
    const tools = createTvTools(fakePlatform().platform);
    expect(byName(tools, "set_input_source").spec.confirm).toBe(true);
    expect(byName(tools, "launch_app").spec.confirm).toBe(true);
    // Reversible ones must not nag the user.
    expect(byName(tools, "set_volume").spec.confirm).toBeUndefined();
    expect(byName(tools, "press_key").spec.confirm).toBeUndefined();
  });
});

describe("createTvTools — apps and navigation", () => {
  it("lists, searches and launches apps", async () => {
    const { platform, calls } = fakePlatform();
    const tools = createTvTools(platform);
    expect(await byName(tools, "list_apps").execute({})).toHaveLength(2);
    expect(await byName(tools, "search_app_by_name").execute({ query: "netflix" }))
      .toEqual([{ id: "com.netflix.ninja", name: "Netflix" }]);
    expect(await byName(tools, "launch_app").execute({ appId: "com.netflix.ninja" })).toEqual({ ok: true });
    expect(calls.launchApp).toEqual(["com.netflix.ninja"]);
  });

  it("sends remote keys", async () => {
    const { platform, calls } = fakePlatform();
    expect(await byName(createTvTools(platform), "press_key").execute({ key: "down" })).toEqual({ ok: true });
    expect(calls.sendKey).toEqual(["down"]);
  });
});

describe("createTvTools — media capability gating", () => {
  it("registers the transport tools when the platform advertises media", async () => {
    const { platform, calls } = fakePlatform({ media: true });
    const tools = createTvTools(platform);
    expect(await byName(tools, "media_play").execute({ uri: "http://x/a.mp4" })).toEqual({ ok: true });
    expect(await byName(tools, "media_pause").execute({})).toEqual({ ok: true });
    expect(await byName(tools, "media_resume").execute({})).toEqual({ ok: true });
    expect(await byName(tools, "media_seek").execute({ positionMs: 90_000 })).toEqual({ ok: true });
    expect(calls).toMatchObject({ play: ["http://x/a.mp4"], pause: 1, resume: 1, seek: [90_000] });
  });

  it("coerces a string position for media_seek", async () => {
    const { platform, calls } = fakePlatform({ media: true });
    await byName(createTvTools(platform), "media_seek").execute({ positionMs: "1500" });
    expect(calls.seek).toEqual([1500]);
  });

  it("hides the media tools entirely when the platform has no media", () => {
    const { platform } = fakePlatform({ media: false });
    const names = createTvTools(platform).map((t) => t.spec.name);
    // The LLM must never see a tool this device can't fulfil.
    expect(names.filter((n) => n.startsWith("media_"))).toEqual([]);
    expect(names).toContain("set_volume");
  });
});
