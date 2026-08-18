import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import { createTizenAdapter } from "@tv-ai-agent/adapter-tizen";
import { createAospAdapter } from "@tv-ai-agent/adapter-aosp";
import { createWebosAdapter } from "@tv-ai-agent/adapter-webos";
import { createTitanAdapter } from "@tv-ai-agent/adapter-titan";
import { createXumoAdapter } from "@tv-ai-agent/adapter-xumo";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";

/**
 * Each target under test: a factory that installs whatever device globals the
 * adapter needs, returns a live PlatformProvider, and a teardown. The mocks
 * mirror the per-adapter unit-test mocks so behaviour is faithful.
 */
export interface Target {
  name: string;
  make: () => PlatformProvider;
  teardown: () => void;
}

const g = globalThis as any;

export function targets(): Target[] {
  return [
    { name: "web", make: () => createWebAdapter(), teardown: () => {} },
    {
      name: "tizen",
      make: () => { installTizen(); return createTizenAdapter(); },
      teardown: () => { delete g.tizen; delete g.webapis; },
    },
    {
      name: "aosp",
      make: () => { installAosp(); return createAospAdapter(); },
      teardown: () => { delete g.TvNativeBridge; },
    },
    {
      name: "webos",
      make: () => { installWebos(); return createWebosAdapter(); },
      teardown: () => { delete g.webOS; delete g.webOSSystem; },
    },
    // The two stubs. They are here for one reason: to prove the vocabulary is the
    // adapter's to *implement* and never the adapter's to *name*. Both are given
    // a bridge that grants the whole script, because this suite asks whether a
    // conforming device behaves identically — what happens on a build that grants
    // less is each adapter's own test, where the interesting answer is which
    // capabilities get withdrawn.
    {
      name: "titan",
      make: () => createTitanAdapter({ bridge: grantingBridge() }),
      teardown: () => {},
    },
    {
      name: "xumo",
      make: () => createXumoAdapter({ bridge: grantingBridge() }),
      teardown: () => {},
    },
  ];
}

const APPS = [
  { id: "com.netflix.ninja", name: "Netflix" },
  { id: "com.youtube.tv", name: "YouTube" },
];

function installTizen(): void {
  const state = { volume: 20, muted: false };
  g.tizen = {
    application: {
      getAppsInfo: (ok: (l: any[]) => void) => ok(APPS.map((a) => ({ id: a.id, name: a.name }))),
      launch: (_id: string, ok: () => void) => ok(),
      getCurrentApplication: () => ({ appInfo: { id: APPS[0]!.id, name: APPS[0]!.name } }),
    },
  };
  g.webapis = {
    audiocontrol: {
      getVolume: () => state.volume,
      setVolume: (n: number) => { state.volume = Math.max(0, Math.min(100, Math.round(n))); },
      getMute: () => state.muted,
      setMute: (m: boolean) => { state.muted = m; },
    },
    productinfo: { getVersion: () => "7.0", getModel: () => "MTK-Tizen" },
    network: { isConnectedToGateway: () => true, getActiveConnectionType: () => 1 },
    tvinfo: { getCurrentSource: () => 0 },
  };
}

function installAosp(): void {
  const state = { volume: 20, muted: false };
  g.TvNativeBridge = {
    getDeviceInfo: () => JSON.stringify({ os: "aosp", osVersion: "14", soc: "mediatek", model: "MTK-AOSP", capabilities: {} }),
    getVolume: () => state.volume,
    setVolume: (n: number) => { state.volume = Math.max(0, Math.min(100, Math.round(n))); },
    getMute: () => state.muted,
    setMute: (m: boolean) => { state.muted = m; },
    getInputSource: () => "app",
    setInputSource: () => {},
    powerStandby: () => {},
    listInstalledApps: () => JSON.stringify(APPS),
    launchApp: () => {},
    getForegroundApp: () => "null",
    sendKey: () => {},
    isOnline: () => true,
    connectionType: () => "ethernet",
    kvGet: () => "",
    kvSet: () => {},
    kvDelete: () => {},
  };
}

function installWebos(): void {
  const state = { volume: 20, muted: false };
  g.webOSSystem = { deviceInfo: JSON.stringify({ modelName: "NVT-webOS", sdkVersion: "7.0" }) };
  g.webOS = {
    service: {
      request: (uri: string, o: any) => {
        const { method, parameters, onSuccess } = o;
        if (uri.includes("audio") && method === "getVolume") return onSuccess({ volume: { volume: state.volume, muted: state.muted } });
        if (uri.includes("audio") && method === "setVolume") { state.volume = Math.max(0, Math.min(100, Math.round(parameters.volume))); return onSuccess({ returnValue: true }); }
        if (uri.includes("audio") && method === "setMuted") { state.muted = parameters.muted; return onSuccess({ returnValue: true }); }
        if (uri.includes("applicationManager") && method === "listApps") return onSuccess({ apps: APPS.map((a) => ({ id: a.id, title: a.name })) });
        if (uri.includes("applicationManager") && method === "launch") return onSuccess({ returnValue: true });
        if (uri.includes("connectionmanager")) return onSuccess({ isInternetConnectionAvailable: true, wired: { state: "connected" } });
        return o.onFailure?.({ errorText: "unhandled" });
      },
    },
  };
}

/**
 * A host bridge that grants everything the acceptance script needs.
 *
 * Shared by both stubs because their bridge shapes are deliberately the same
 * small surface — and if they diverge as the real integrations land, this splits
 * into two, which is a change worth seeing in a diff.
 */
function grantingBridge() {
  const state = { volume: 20, muted: false, input: "hdmi1" };
  return {
    getDeviceInfo: () => ({ osVersion: "1.0", soc: "unknown", model: "stub-tv" }),
    getVolume: () => state.volume,
    setVolume: (n: number) => { state.volume = Math.max(0, Math.min(100, Math.round(n))); },
    getMute: () => state.muted,
    setMute: (m: boolean) => { state.muted = m; },
    getInputSource: () => state.input,
    setInputSource: (s: string) => { state.input = s; },
    powerStandby: () => {},
    listInstalledApps: () => APPS,
    launchApp: () => {},
    getForegroundApp: () => null,
    sendKey: () => {},
    isOnline: () => true,
    connectionType: () => "ethernet",
  };
}
