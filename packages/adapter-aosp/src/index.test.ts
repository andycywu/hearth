import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertProviderContract } from "@tv-ai-agent/platform-api";
import { createAospAdapter } from "./index.js";

const bridge = (): any => (globalThis as any).TvNativeBridge;

/** Minimal in-memory stand-in for the Kotlin TvNativeBridge. */
function installMockBridge(): void {
  const state = { volume: 20, muted: false, input: "app", kv: new Map<string, string>() };
  const apps = [
    { id: "com.netflix.ninja", name: "Netflix" },
    { id: "com.google.android.youtube.tv", name: "YouTube" },
  ];
  (globalThis as any).TvNativeBridge = {
    getDeviceInfo: () => JSON.stringify({
      os: "aosp", osVersion: "14", soc: "mediatek", model: "MTK-ref",
      capabilities: { media: false, voice: false },
    }),
    getVolume: () => state.volume,
    setVolume: (l: number) => { state.volume = Math.max(0, Math.min(100, Math.round(l))); },
    getMute: () => state.muted,
    setMute: (m: boolean) => { state.muted = m; },
    getInputSource: () => state.input,
    setInputSource: (s: string) => { state.input = s; },
    powerStandby: () => {},
    listInstalledApps: () => JSON.stringify(apps),
    launchApp: () => {},
    getForegroundApp: () => "null",
    sendKey: () => {},
    isOnline: () => true,
    connectionType: () => "ethernet",
    kvGet: (k: string) => state.kv.get(k) ?? "",
    kvSet: (k: string, v: string) => { state.kv.set(k, v); },
    kvDelete: (k: string) => { state.kv.delete(k); },
  };
}

describe("adapter-aosp", () => {
  beforeEach(() => installMockBridge());
  afterEach(() => { delete (globalThis as any).TvNativeBridge; });

  it("satisfies the provider contract via the native bridge", async () => {
    await assertProviderContract(() => createAospAdapter());
  });

  it("throws a useful error outside the host WebView", () => {
    delete (globalThis as any).TvNativeBridge;
    expect(() => createAospAdapter()).toThrow(/TvNativeBridge not found/);
  });

  describe("navigation readiness", () => {
    // On retail Android TV, keys only work once the user enables the
    // accessibility service — so isAvailable() must mirror the service state,
    // letting the agent prompt for setup instead of silently doing nothing.
    it("is unavailable while the accessibility service is off", async () => {
      bridge().isAccessibilityEnabled = () => false;
      expect(await createAospAdapter().navigation.isAvailable!()).toBe(false);
    });

    it("is available once the accessibility service is on", async () => {
      bridge().isAccessibilityEnabled = () => true;
      expect(await createAospAdapter().navigation.isAvailable!()).toBe(true);
    });

    it("is unavailable on an older host that doesn't expose the check", async () => {
      // The bridge method is optional; assume "not ready" rather than "ready".
      expect(bridge().isAccessibilityEnabled).toBeUndefined();
      expect(await createAospAdapter().navigation.isAvailable!()).toBe(false);
    });

    it("routes requestSetup to the Accessibility settings screen", async () => {
      let opened = 0;
      bridge().openAccessibilitySettings = () => { opened++; };
      await createAospAdapter().navigation.requestSetup!();
      expect(opened).toBe(1);
    });

    it("doesn't blow up when the host can't open settings", async () => {
      expect(bridge().openAccessibilitySettings).toBeUndefined();
      await expect(createAospAdapter().navigation.requestSetup!()).resolves.toBeUndefined();
    });
  });

  describe("opaque native exceptions", () => {
    // Android replaces whatever Kotlin throws inside a @JavascriptInterface
    // method with a generic message, so the adapter has to supply the reason.
    const androidStyleThrow = () => { throw new Error("Java exception was raised during method invocation"); };

    it("explains an unavailable input switch", async () => {
      bridge().setInputSource = androidStyleThrow;
      await expect(createAospAdapter().system.setInputSource("hdmi1"))
        .rejects.toThrow(/Not supported: setInputSource .*platform signature/);
    });

    it("explains an unavailable standby", async () => {
      bridge().powerStandby = androidStyleThrow;
      await expect(createAospAdapter().system.powerStandby())
        .rejects.toThrow(/Not supported: powerStandby .*DEVICE_POWER/);
    });

    it("points at the accessibility service when navigation is off", async () => {
      bridge().isAccessibilityEnabled = () => false;
      bridge().sendKey = androidStyleThrow;
      await expect(createAospAdapter().navigation.sendKey("ok"))
        .rejects.toThrow(/Not supported: navigation — enable the accessibility service/);
    });

    it("blames the key, not the setup, once the service is on", async () => {
      bridge().isAccessibilityEnabled = () => true;
      bridge().sendKey = androidStyleThrow;
      await expect(createAospAdapter().navigation.sendKey("channelup"))
        .rejects.toThrow(/Not supported: key 'channelup' via accessibility/);
    });

    it("stays quiet when the native call succeeds", async () => {
      await expect(createAospAdapter().navigation.sendKey("ok")).resolves.toBeUndefined();
    });
  });

  it("clamps the volume the host receives", async () => {
    const platform = createAospAdapter();
    await platform.system.setVolume(140);
    expect(await platform.system.getVolume()).toBe(100);
    await platform.system.setVolume(-10);
    expect(await platform.system.getVolume()).toBe(0);
  });

  it("maps an absent foreground app and absent storage key to null", async () => {
    const platform = createAospAdapter();
    expect(await platform.apps.getForegroundApp()).toBeNull();
    expect(await platform.storage.get("nope")).toBeNull();
    await platform.storage.set("k", "v");
    expect(await platform.storage.get("k")).toBe("v");
  });
});
