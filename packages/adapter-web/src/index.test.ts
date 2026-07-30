import { describe, it, expect } from "vitest";
import { assertProviderContract } from "@tv-ai-agent/platform-api";
import { createWebAdapter } from "./index.js";

describe("adapter-web", () => {
  it("satisfies the provider contract", async () => {
    await assertProviderContract(() => createWebAdapter());
  });

  it("advertises only the capabilities it actually fills", () => {
    // Every adapter copies this `has()` rule, and the tool registry relies on it
    // to hide tools the device can't fulfil.
    const platform = createWebAdapter();
    expect(platform.has("media")).toBe(true);
    expect(platform.has("voice")).toBe(false); // no Web Speech outside a browser
    expect(platform.device.capabilities.voice).toBe(false);
  });

  it("keeps volume, mute and input source in memory across calls", async () => {
    const platform = createWebAdapter();
    await platform.system.setVolume(150);
    expect(await platform.system.getVolume()).toBe(100); // clamped
    await platform.system.setVolume(-5);
    expect(await platform.system.getVolume()).toBe(0);
    await platform.system.setMute(true);
    expect(await platform.system.getMute()).toBe(true);
    await platform.system.setInputSource("hdmi3");
    expect(await platform.system.getInputSource()).toBe("hdmi3");
  });

  it("gives each adapter instance its own state", async () => {
    const a = createWebAdapter();
    const b = createWebAdapter();
    await a.system.setVolume(70);
    expect(await b.system.getVolume()).toBe(20);
  });

  it("resolves a spoken app name case-insensitively", async () => {
    const platform = createWebAdapter();
    expect(await platform.apps.findAppsByName("NETFLIX")).toEqual([
      { id: "com.netflix.ninja", name: "Netflix" },
    ]);
    expect(await platform.apps.findAppsByName("nope")).toEqual([]);
  });
});
