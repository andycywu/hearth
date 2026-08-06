import {
  hasCapability,
  matchAppsByName, createLocalStorageStore, createWebSpeechPipeline,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey,
} from "@tv-ai-agent/platform-api";

/**
 * Experimental webOS (LG) adapter. On webOS the runtime is a web app that talks
 * to the OS through the **Luna Service Bus** via the injected `webOS.service.request`
 * global. This file maps the HAL onto Luna calls — the same agent core runs
 * unchanged, proving the HAL extends to a third OS with no core edits.
 *
 * Luna URIs/return shapes vary a little across webOS versions; calls are wrapped
 * defensively and typed as `any` (like the Tizen adapter) to avoid a hard
 * dependency on webOS type packages. Unsupported controls throw "not supported"
 * so the agent degrades via `has()`.
 */
declare const webOS: any;
declare const webOSSystem: any;

/** Promisified Luna request. */
function luna(uri: string, method: string, parameters: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      webOS.service.request(uri, {
        method,
        parameters,
        onSuccess: (res: any) => resolve(res),
        onFailure: (err: any) => reject(new Error(String(err?.errorText ?? err))),
      });
    } catch (e) {
      reject(e as Error);
    }
  });
}

const AUDIO = "luna://com.webos.audio";
const APPMGR = "luna://com.webos.applicationManager";
const CONN = "luna://com.palm.connectionmanager";

export function createWebosAdapter(): PlatformProvider {
  /**
   * webOS runs a Chromium WebView too, so Web Speech is worth trying before
   * reaching for LG's voice services, which are partner-gated. Feature-detected,
   * so a firmware without it reports no voice rather than advertising one that
   * throws. `?diag`'s `voice.engines` row says what a given build actually has —
   * unverified here, since webOS still needs an install target.
   */
  const voice = createWebSpeechPipeline();

  const device: DeviceInfo = {
    os: "webos",
    osVersion: safe(() => webOSSystem?.deviceInfo && JSON.parse(webOSSystem.deviceInfo).sdkVersion) ?? "unknown",
    soc: detectSoc(),
    model: safe(() => webOSSystem?.deviceInfo && JSON.parse(webOSSystem.deviceInfo).modelName) ?? "unknown",
    capabilities: { media: true, voice: voice !== undefined },
  };

  // webOS web apps get a normal localStorage; a bare Map here meant
  // `persistKey` silently lost the conversation on every restart.
  const kv = createLocalStorageStore("tv-ai-agent");

  const provider: PlatformProvider = {
    device,
    system: {
      getVolume: async () => Number((await luna(AUDIO, "getVolume"))?.volume?.volume ?? 0),
      setVolume: async (l) => { await luna(AUDIO, "setVolume", { volume: clamp(l) }); },
      getMute: async () => Boolean((await luna(AUDIO, "getVolume"))?.volume?.muted ?? false),
      setMute: async (m) => { await luna(AUDIO, "setMuted", { muted: m }); },
      getInputSource: async () => "app" as InputSource,
      setInputSource: async (s) => { notSupported("setInputSource (partner API)", s); },
      powerStandby: async () => { notSupported("powerStandby (partner API)"); },
    },
    apps: {
      listInstalledApps: listApps,
      launchApp: async (id) => { await luna(APPMGR, "launch", { id }); },
      getForegroundApp: async () => {
        const r = safe(() => luna(APPMGR, "getForegroundAppInfo"));
        const info = r ? await r : undefined;
        return info?.appId ? { id: info.appId, name: info.appId } : null;
      },
      findAppsByName: async (q) => matchAppsByName(await listApps(), q),
    },
    navigation: {
      sendKey: async (k: RemoteKey) => dispatchKey(k),
      isAvailable: async () => true,
    },
    network: {
      isOnline: async () => Boolean((await luna(CONN, "getStatus"))?.isInternetConnectionAvailable ?? false),
      connectionType: async () => {
        const st = await luna(CONN, "getStatus");
        if (st?.wired?.state === "connected") return "ethernet";
        if (st?.wifi?.state === "connected") return "wifi";
        return "none";
      },
    },
    storage: kv,
    ...(voice ? { voice } : {}),
    media: {
      // webOS media is app-managed (MediaController / <video>); inject transport keys.
      play: async (_uri) => dispatchKey("playpause"),
      pause: async () => dispatchKey("playpause"),
      resume: async () => dispatchKey("playpause"),
      seek: async (_ms) => { /* app-managed */ },
    },
    has: (cap) => hasCapability(provider, cap),
    init: async () => { /* nothing to wire; Luna is available immediately */ },
  };
  return provider;

  async function listApps(): Promise<AppEntry[]> {
    const res = await luna(APPMGR, "listApps");
    const apps = (res?.apps ?? []) as any[];
    return apps.map((a) => ({ id: a.id, name: a.title ?? a.id, version: a.version }));
  }
}

function detectSoc(): string {
  const m = (safe(() => webOSSystem?.deviceInfo && JSON.parse(webOSSystem.deviceInfo).modelName) ?? "").toLowerCase();
  if (m.includes("mtk") || m.includes("mediatek")) return "mediatek";
  if (m.includes("nvt") || m.includes("novatek")) return "novatek";
  return "unknown";
}

const WEBOS_KEYCODES: Partial<Record<RemoteKey, number>> = {
  up: 38, down: 40, left: 37, right: 39, ok: 13, back: 461, home: 36,
  playpause: 415, stop: 413, rewind: 412, fastforward: 417,
  channelup: 33, channeldown: 34, menu: 18,
};
function dispatchKey(k: RemoteKey): void {
  const keyCode = WEBOS_KEYCODES[k];
  if (keyCode == null || typeof document === "undefined") return;
  document.dispatchEvent(new KeyboardEvent("keydown", { keyCode } as any));
}
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
function safe<T>(fn: () => T): T | undefined { try { return fn(); } catch { return undefined; } }
function notSupported(what: string, ..._a: unknown[]): never { throw new Error(`Not supported: ${what}`); }
