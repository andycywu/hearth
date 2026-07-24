import { describe, it, beforeEach, afterEach } from "vitest";
import { assertProviderContract } from "@tv-ai-agent/platform-api";
import { createAospAdapter } from "./index.js";

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
});
