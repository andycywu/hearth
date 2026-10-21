import {
  hasCapability,
  matchAppsByName, createLocalStorageStore, createWebSpeechPipeline,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey, type ScreenLayout,
} from "@hearthkit/platform-api";

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
    layout: "hearth" as ScreenLayout,
    apps: [
      { id: "com.netflix.ninja", name: "Netflix" },
      { id: "com.google.android.youtube.tv", name: "YouTube" },
    ] as AppEntry[],
  };

  const voice = createWebSpeechPipeline();

  const device: DeviceInfo = {
    os: "web", osVersion: navigatorVersion(), soc: "unknown", model: "dev-browser",
    capabilities: { media: true, voice: voice !== undefined },
  };

  const provider: PlatformProvider = {
    device,
    voice,
    system: {
      getVolume: async () => state.volume,
      setVolume: async (l) => { state.volume = clamp(l); },
      getMute: async () => state.muted,
      setMute: async (m) => { state.muted = m; },
      getInputSource: async () => state.input,
      setInputSource: async (s) => { state.input = s; },
      powerStandby: async () => { /* no-op in browser */ },
    },
    apps: {
      listInstalledApps: async () => state.apps,
      launchApp: async (id) => { console.info("[web] launch", id); },
      getForegroundApp: async () => null,
      findAppsByName: async (q) => matchAppsByName(state.apps, q),
    },
    navigation: {
      sendKey: async (k: RemoteKey) => { console.info("[web] key", k); },
      isAvailable: async () => true,
    },
    network: { isOnline: async () => true, connectionType: async () => "ethernet" },
    // localStorage in a browser, memory in Node — so the harness keeps a
    // session across reloads while tests stay isolated.
    storage: createLocalStorageStore("hearth"),
    media: {
      play: async (uri) => { console.info("[web] play", uri); },
      pause: async () => { console.info("[web] pause"); },
      resume: async () => { console.info("[web] resume"); },
      seek: async (ms) => { console.info("[web] seek", ms); },
    },
    // In memory: a browser has no video window to place, so this only holds the answer. It exists so the contract and the layers
    // above can be exercised without a television.
    display: { getLayout: async () => state.layout, setLayout: async (l) => { state.layout = l; } },
    has: (cap) => hasCapability(provider, cap),
    init: async () => { /* nothing to wire */ },
  };
  return provider;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
function navigatorVersion(): string {
  return typeof navigator !== "undefined" ? navigator.userAgent : "node";
}
