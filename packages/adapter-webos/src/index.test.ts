import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertProviderContract } from "@tv-ai-agent/platform-api";
import { createWebosAdapter } from "./index.js";

/** Minimal stand-in for the webOS Luna Service Bus + system globals. */
function installWebosMocks(): void {
  const state = { volume: 20, muted: false };
  const apps = [
    { id: "netflix", title: "Netflix" },
    { id: "youtube.leanback.v4", title: "YouTube" },
  ];
  (globalThis as any).webOSSystem = {
    deviceInfo: JSON.stringify({ modelName: "OLED65-webOS", sdkVersion: "7.0.0" }),
  };
  (globalThis as any).webOS = {
    service: {
      request: (uri: string, o: any) => {
        const { method, parameters, onSuccess, onFailure } = o;
        try {
          if (uri.includes("audio") && method === "getVolume")
            return onSuccess({ volume: { volume: state.volume, muted: state.muted } });
          if (uri.includes("audio") && method === "setVolume") { state.volume = parameters.volume; return onSuccess({ returnValue: true }); }
          if (uri.includes("audio") && method === "setMuted") { state.muted = parameters.muted; return onSuccess({ returnValue: true }); }
          if (uri.includes("applicationManager") && method === "listApps") return onSuccess({ apps });
          if (uri.includes("applicationManager") && method === "launch") return onSuccess({ returnValue: true });
          if (uri.includes("applicationManager") && method === "getForegroundAppInfo") return onSuccess({ appId: "netflix" });
          if (uri.includes("connectionmanager") && method === "getStatus")
            return onSuccess({ isInternetConnectionAvailable: true, wired: { state: "connected" } });
          onFailure({ errorText: `unhandled ${uri}/${method}` });
        } catch (e) {
          onFailure({ errorText: String(e) });
        }
      },
    },
  };
}

describe("adapter-webos", () => {
  beforeEach(() => installWebosMocks());
  afterEach(() => {
    delete (globalThis as any).webOS;
    delete (globalThis as any).webOSSystem;
  });

  it("satisfies the provider contract via mocked Luna services", async () => {
    await assertProviderContract(() => createWebosAdapter());
  });

  it("reports navigation as always available (keys are dispatched in-app)", async () => {
    expect(await createWebosAdapter().navigation.isAvailable!()).toBe(true);
  });

  it("degrades the partner-gated controls via a 'not supported' throw", async () => {
    // has() can't express "present but privileged", so the adapter throws the
    // soft error the agent and the diagnostics probe both understand.
    const platform = createWebosAdapter();
    await expect(platform.system.setInputSource("hdmi1")).rejects.toThrow(/not supported/i);
    await expect(platform.system.powerStandby()).rejects.toThrow(/not supported/i);
  });

  it("reads volume and mute over Luna and writes them back", async () => {
    const platform = createWebosAdapter();
    expect(await platform.system.getVolume()).toBe(20);
    await platform.system.setVolume(55);
    expect(await platform.system.getVolume()).toBe(55);
    await platform.system.setMute(true);
    expect(await platform.system.getMute()).toBe(true);
  });

  it("maps Luna's app list (title → name) and resolves a spoken name", async () => {
    const platform = createWebosAdapter();
    expect(await platform.apps.listInstalledApps())
      .toEqual([
        { id: "netflix", name: "Netflix", version: undefined },
        { id: "youtube.leanback.v4", name: "YouTube", version: undefined },
      ]);
    expect(await platform.apps.findAppsByName("you")).toEqual([
      { id: "youtube.leanback.v4", name: "YouTube", version: undefined },
    ]);
  });

  it("surfaces a Luna failure as an Error rather than hanging", async () => {
    (globalThis as any).webOS.service.request = (_uri: string, o: any) =>
      o.onFailure({ errorText: "service unavailable" });
    await expect(createWebosAdapter().network.isOnline()).rejects.toThrow(/service unavailable/);
  });
});
