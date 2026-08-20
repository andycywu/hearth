import { describe, it, expect } from "vitest";
import { assertProviderContract, isTvUnsupported } from "@hearthkit/platform-api";
import { createXumoAdapter, type XumoBridge } from "./index.js";

/**
 * The realistic Xumo shape: an app gets device info and network, and does not get
 * volume, input or the app list. This is the case the architecture has to
 * survive, so it is the default in these tests rather than the exception.
 */
function appLevelBridge(): XumoBridge {
  return {
    getDeviceInfo: () => ({ osVersion: "rdk-7", soc: "unknown", model: "Xumo TV" }),
    isOnline: () => true,
    connectionType: () => "wifi",
    sendKey: () => {},
  };
}

describe("Xumo adapter", () => {
  it("satisfies the provider contract with only app-level access", async () => {
    await assertProviderContract(() => createXumoAdapter({ bridge: appLevelBridge() }));
  });

  it("satisfies it with a fuller bridge too", async () => {
    const state = { volume: 20, muted: false };
    const apps = [{ id: "com.xumo.play", name: "Xumo Play" }];
    await assertProviderContract(() => createXumoAdapter({
      bridge: {
        ...appLevelBridge(),
        getVolume: () => state.volume,
        setVolume: (n) => { state.volume = n; },
        getMute: () => state.muted,
        setMute: (m) => { state.muted = m; },
        listInstalledApps: () => apps,
        launchApp: () => {},
      },
    }));
  });

  it("refuses TV control as unsupported rather than failing", async () => {
    const p = createXumoAdapter({ bridge: appLevelBridge() });
    for (const call of [
      () => p.system.getVolume(),
      () => p.system.setInputSource("hdmi2"),
      () => p.apps.listInstalledApps(),
      () => p.apps.getForegroundApp(),
      () => p.system.powerStandby(),
    ]) {
      await expect(call()).rejects.toSatisfy(isTvUnsupported);
    }
  });

  it("says an app cannot do it, rather than blaming the wiring", async () => {
    const p = createXumoAdapter({ bridge: appLevelBridge() });
    await expect(p.system.getVolume()).rejects.toThrow(/isn't available to an app/);
    await expect(p.system.powerStandby()).rejects.toThrow(/an app can't put this TV into standby/);
  });

  it("does not claim nothing is in the foreground when it simply cannot see", async () => {
    // `null` would be an answer. Refusing is the truth.
    const p = createXumoAdapter({ bridge: appLevelBridge() });
    await expect(p.apps.getForegroundApp()).rejects.toThrow(/doesn't tell an app/);
  });

  it("keeps what it does have: identity, network, storage", async () => {
    const p = createXumoAdapter({ bridge: appLevelBridge() });
    expect(p.device.os).toBe("xumo");
    expect(p.device.model).toBe("Xumo TV");
    expect(await p.network.connectionType()).toBe("wifi");
    await p.storage.set("k", "v");
    expect(await p.storage.get("k")).toBe("v");
    await p.storage.delete("k");
  });
});
