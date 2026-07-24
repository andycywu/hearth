import type {
  PlatformProvider, DeviceInfo, AppEntry, InputSource, RemoteKey,
} from "@tv-ai-agent/platform-api";

/**
 * In-memory adapter. Lets the whole runtime run in a normal browser or Node for
 * development, demos and CI, with no TV present. Also the reference for what an
 * adapter must implement.
 */
export function createWebAdapter(): PlatformProvider {
  const state = {
    volume: 20,
    muted: false,
    input: "tv" as InputSource,
    kv: new Map<string, string>(),
    apps: [
      { id: "com.netflix.ninja", name: "Netflix" },
      { id: "com.google.android.youtube.tv", name: "YouTube" },
    ] as AppEntry[],
  };

  const device: DeviceInfo = {
    os: "web", osVersion: navigatorVersion(), soc: "unknown", model: "dev-browser",
    capabilities: { media: false, voice: false },
  };

  const provider: PlatformProvider = {
    device,
    system: {
      getVolume: async () => state.volume,
      setVolume: async (l) => { state.volume = clamp(l); },
      setMute: async (m) => { state.muted = m; },
      getInputSource: async () => state.input,
      setInputSource: async (s) => { state.input = s; },
      powerStandby: async () => { /* no-op in browser */ },
    },
    apps: {
      listInstalledApps: async () => state.apps,
      launchApp: async (id) => { console.info("[web] launch", id); },
      getForegroundApp: async () => null,
    },
    navigation: { sendKey: async (k: RemoteKey) => { console.info("[web] key", k); } },
    network: { isOnline: async () => true, connectionType: async () => "ethernet" },
    storage: {
      get: async (k) => state.kv.get(k) ?? null,
      set: async (k, v) => { state.kv.set(k, v); },
      delete: async (k) => { state.kv.delete(k); },
    },
    has: (cap) => cap in provider && (provider as any)[cap] !== undefined,
    init: async () => { /* nothing to wire */ },
  };
  return provider;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
function navigatorVersion(): string {
  return typeof navigator !== "undefined" ? navigator.userAgent : "node";
}
