import {
  matchAppsByName,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey,
} from "@tv-ai-agent/platform-api";

/**
 * AOSP / Android TV adapter. The runtime web bundle is hosted inside an Android
 * WebView. The Kotlin host injects a JS object named `TvNativeBridge`
 * (via addJavascriptInterface) that returns JSON strings. This adapter wraps
 * that bridge so the same agent core runs unchanged. See apps/aosp-app for the
 * native host and the exact bridge contract.
 */
interface NativeBridge {
  getDeviceInfo(): string;            // JSON DeviceInfo
  getVolume(): number;
  setVolume(level: number): void;
  getMute(): boolean;
  setMute(mute: boolean): void;
  getInputSource(): string;
  setInputSource(source: string): void;
  powerStandby(): void;
  listInstalledApps(): string;        // JSON AppEntry[]
  launchApp(appId: string): void;
  getForegroundApp(): string;         // JSON AppEntry | "null"
  sendKey(key: string): void;
  isAccessibilityEnabled?(): boolean;
  openAccessibilitySettings?(): void;
  isOnline(): boolean;
  connectionType(): string;
  kvGet(key: string): string;         // "" when absent
  kvSet(key: string, value: string): void;
  kvDelete(key: string): void;
}

export function createAospAdapter(): PlatformProvider {
  // Read the injected interface off globalThis: a bare `TvNativeBridge`
  // reference throws a bare ReferenceError when the host hasn't installed it
  // (plain browser, or the bundle ran before addJavascriptInterface), which
  // would hide the actionable message below.
  const bridge = (globalThis as { TvNativeBridge?: NativeBridge }).TvNativeBridge;
  if (!bridge) throw new Error("TvNativeBridge not found — are you running inside the AOSP host WebView?");

  const info = JSON.parse(bridge.getDeviceInfo()) as Partial<DeviceInfo>;
  const device: DeviceInfo = {
    os: "aosp",
    osVersion: info.osVersion ?? "unknown",
    soc: info.soc ?? "unknown",
    model: info.model ?? "unknown",
    capabilities: info.capabilities ?? { media: true, voice: false },
  };

  const provider: PlatformProvider = {
    device,
    system: {
      getVolume: async () => bridge.getVolume(),
      setVolume: async (l) => bridge.setVolume(clamp(l)),
      getMute: async () => bridge.getMute(),
      setMute: async (m) => bridge.setMute(m),
      getInputSource: async () => bridge.getInputSource() as InputSource,
      setInputSource: async (s) => bridge.setInputSource(s),
      powerStandby: async () => bridge.powerStandby(),
    },
    apps: {
      listInstalledApps: async () => JSON.parse(bridge.listInstalledApps()) as AppEntry[],
      launchApp: async (id) => bridge.launchApp(id),
      getForegroundApp: async () => {
        const raw = bridge.getForegroundApp();
        return raw === "null" ? null : (JSON.parse(raw) as AppEntry);
      },
      findAppsByName: async (q) =>
        matchAppsByName(JSON.parse(bridge.listInstalledApps()) as AppEntry[], q),
    },
    navigation: {
      sendKey: async (k: RemoteKey) => bridge.sendKey(k),
      isAvailable: async () => bridge.isAccessibilityEnabled?.() ?? false,
      requestSetup: async () => bridge.openAccessibilitySettings?.(),
    },
    network: {
      isOnline: async () => bridge.isOnline(),
      connectionType: async () => bridge.connectionType() as "wifi" | "ethernet" | "none",
    },
    storage: {
      get: async (k) => { const v = bridge.kvGet(k); return v === "" ? null : v; },
      set: async (k, v) => bridge.kvSet(k, v),
      delete: async (k) => bridge.kvDelete(k),
    },
    has: (cap) => cap in provider && (provider as any)[cap] !== undefined,
    init: async () => { /* bridge is ready once WebView finished loading */ },
  };
  return provider;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
