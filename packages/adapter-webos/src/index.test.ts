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

describe("a page with no webOSTV.js", () => {
  /**
   * `webOS.service.request` is not a platform global — it comes from LG's
   * webOSTV.js, which the *app* has to ship. This app never did, so on the
   * webOS TV 26 simulator every capability failed with a bare
   * `ReferenceError: webOS is not defined` on the adapter's first run outside
   * a unit test. The unit tests could not see it: they install a `webOS` mock,
   * which is precisely the thing a real page was missing.
   *
   * `WebOSServiceBridge` is the native object webOSTV.js wraps, and it is there
   * without shipping anything. Verified on the simulator against
   * `com.palm.connectionmanager/getStatus`, which returns real state.
   */
  let calls: string[];

  beforeEach(() => {
    installWebosMocks();
    delete (globalThis as any).webOS;   // exactly what a page without the library has
    calls = [];
    (globalThis as any).WebOSServiceBridge = class {
      onservicecallback: ((raw: string) => void) | undefined;
      call(uri: string, _params: string): void {
        calls.push(uri);
        const reply = uri.endsWith("/getStatus")
          ? { returnValue: true, isInternetConnectionAvailable: true, wired: { state: "connected" } }
          : { returnValue: false, errorCode: -1, errorText: `Unknown method "x" for category "/"` };
        setTimeout(() => this.onservicecallback?.(JSON.stringify(reply)), 0);
      }
    };
  });

  afterEach(() => { delete (globalThis as any).WebOSServiceBridge; });

  it("falls back to the native bridge instead of throwing ReferenceError", async () => {
    await expect(createWebosAdapter().network.isOnline()).resolves.toBe(true);
    expect(calls).toEqual(["luna://com.palm.connectionmanager/getStatus"]);
  });

  it("reads a real answer through it", async () => {
    await expect(createWebosAdapter().network.connectionType()).resolves.toBe("ethernet");
  });

  it("calls a method the build doesn't have `unsupported`, not `failed`", async () => {
    // The bridge reports service errors in the payload rather than throwing, so
    // without this an unknown method looked like success with undefined fields.
    const { isTvUnsupported } = await import("@tv-ai-agent/platform-api");
    await expect(createWebosAdapter().system.getVolume()).rejects.toSatisfy(isTvUnsupported);
  });

  it("says so plainly when there is no bridge at all", async () => {
    delete (globalThis as any).WebOSServiceBridge;
    const { isTvUnsupported } = await import("@tv-ai-agent/platform-api");
    await expect(createWebosAdapter().network.isOnline()).rejects.toSatisfy(isTvUnsupported);
  });
});
