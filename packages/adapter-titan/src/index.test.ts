import { describe, it, expect } from "vitest";
import { assertProviderContract, isTvUnsupported } from "@hearthkit/platform-api";
import { createTitanAdapter, type TitanBridge } from "./index.js";

/** A Titan host that grants everything — what a partner build might look like. */
function fullBridge(): TitanBridge {
  const state = { volume: 20, muted: false, input: "hdmi1" };
  const apps = [{ id: "com.netflix.ninja", name: "Netflix" }];
  return {
    getDeviceInfo: () => ({ osVersion: "3.0", soc: "mediatek", model: "MTK-Titan" }),
    getVolume: () => state.volume,
    setVolume: (n) => { state.volume = n; },
    getMute: () => state.muted,
    setMute: (m) => { state.muted = m; },
    getInputSource: () => state.input,
    setInputSource: (s) => { state.input = s; },
    powerStandby: () => {},
    listInstalledApps: () => apps,
    launchApp: () => {},
    getForegroundApp: () => apps[0]!,
    sendKey: () => {},
    isOnline: () => true,
    connectionType: () => "wifi",
  };
}

describe("Titan adapter", () => {
  it("satisfies the provider contract when the bridge is complete", async () => {
    await assertProviderContract(() => createTitanAdapter({ bridge: fullBridge() }));
  });

  it("satisfies the same contract with no bridge at all", async () => {
    // The point of the capability-aware contract: an adapter that can only refuse
    // is a *smaller* adapter, not a broken one. It has to refuse coherently.
    await assertProviderContract(() => createTitanAdapter());
  });

  it("refuses in the typed way, so the agent withdraws instead of retrying", async () => {
    const p = createTitanAdapter();
    await expect(p.system.getVolume()).rejects.toSatisfy(isTvUnsupported);
    await expect(p.apps.listInstalledApps()).rejects.toSatisfy(isTvUnsupported);
    await expect(p.system.setInputSource("hdmi2")).rejects.toThrow(/no Titan bridge/);
  });

  it("says which of the two problems it is", async () => {
    // A partial bridge and a missing bridge are different jobs for whoever reads
    // `?diag`: one is a build restriction, the other is unfinished wiring.
    const partial = createTitanAdapter({ bridge: { getVolume: () => 20, setVolume: () => {} } });
    await expect(partial.apps.listInstalledApps()).rejects.toThrow(/not on this Titan build/);
    expect(await partial.system.getVolume()).toBe(20);
  });

  it("reports capabilities per method, not per platform", () => {
    const full = createTitanAdapter({ bridge: fullBridge() });
    expect(full.device.capabilities).toMatchObject({ volume: true, apps: true, input: true });
    expect(createTitanAdapter().device.capabilities).toMatchObject({ volume: false, apps: false });
  });

  it("still knows about the network without a bridge, because the browser does", async () => {
    const p = createTitanAdapter();
    expect(typeof await p.network.isOnline()).toBe("boolean");
    expect(await p.network.connectionType()).toBe("ethernet");
  });

  it("clamps volume like every other adapter", async () => {
    const bridge = fullBridge();
    const p = createTitanAdapter({ bridge });
    await p.system.setVolume(999);
    expect(await p.system.getVolume()).toBe(100);
    await p.system.setVolume(-5);
    expect(await p.system.getVolume()).toBe(0);
  });
});
