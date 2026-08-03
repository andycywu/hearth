import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertProviderContract } from "@tv-ai-agent/platform-api";
import { createTizenAdapter } from "./index.js";

/** Minimal stand-ins for the on-device `tizen.*` / `webapis.*` globals. */
function installTizenMocks(): void {
  const state = { volume: 20, muted: false };
  const apps = [
    { id: "org.tizen.netflix", name: "Netflix", version: "1.0" },
    { id: "org.tizen.youtube", name: "YouTube", version: "1.0" },
  ];
  const first = apps[0]!;
  (globalThis as any).tizen = {
    application: {
      getAppsInfo: (ok: (l: any[]) => void) => ok(apps),
      launch: (_id: string, ok: () => void) => ok(),
      getCurrentApplication: () => ({ appInfo: { id: first.id, name: first.name } }),
    },
  };
  (globalThis as any).webapis = {
    audiocontrol: {
      getVolume: () => state.volume,
      setVolume: (l: number) => { state.volume = Math.max(0, Math.min(100, Math.round(l))); },
      getMute: () => state.muted,
      setMute: (m: boolean) => { state.muted = m; },
    },
    productinfo: { getVersion: () => "7.0", getModel: () => "MTK-Tizen-ref" },
    network: { isConnectedToGateway: () => true, getActiveConnectionType: () => 1 },
    tvinfo: { getCurrentSource: () => 0 },
  };
}

describe("adapter-tizen", () => {
  beforeEach(() => installTizenMocks());
  afterEach(() => {
    delete (globalThis as any).tizen;
    delete (globalThis as any).webapis;
  });

  it("satisfies the provider contract via mocked Tizen Web APIs", async () => {
    await assertProviderContract(() => createTizenAdapter());
  });

  it("detects MediaTek SoC from the model string", async () => {
    const p = createTizenAdapter();
    if (p.device.soc !== "mediatek") {
      throw new Error(`expected mediatek, got ${p.device.soc}`);
    }
  });

  it("names the cause when the host page didn't load webapis", async () => {
    // The real failure on the emulator: `webapis` is loaded by a $WEBAPIS script
    // tag, not injected like `tizen`. Without it the adapter used to die with
    // "cannot read property of undefined", which tells you nothing from a TV.
    delete (globalThis as any).webapis;
    const p = createTizenAdapter();

    // Device info degrades quietly — that's the "unknown" on screen.
    expect(p.device.osVersion).toBe("unknown");
    expect(p.device.model).toBe("unknown");

    // Anything that actually needs webapis says why.
    await expect(p.system.getVolume()).rejects.toThrow(/webapis is not loaded.*\$WEBAPIS/s);
    await expect(p.system.setVolume(20)).rejects.toThrow(/webapis is not loaded/);
    await expect(p.system.setMute(true)).rejects.toThrow(/webapis is not loaded/);
  });
});
