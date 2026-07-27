import { describe, it, beforeEach, afterEach } from "vitest";
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
});
