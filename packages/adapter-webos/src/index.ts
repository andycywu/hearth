import {
  TvUnsupportedError,
  hasCapability,
  matchAppsByName, createLocalStorageStore, createWebSpeechPipeline,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey,
} from "@hearthkit/platform-api";

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
declare const WebOSServiceBridge: any;
declare const PalmServiceBridge: any;

/** How long to wait for the Luna bus before deciding the call is lost. */
const LUNA_TIMEOUT_MS = 10_000;

/**
 * Promisified Luna request.
 *
 * Two transports, because the obvious one is not always there.
 * `webOS.service.request` comes from LG's **webOSTV.js**, a library the *app*
 * has to ship — the platform does not inject it. This app never did, so on the
 * webOS TV 26 simulator every single capability failed with a bare
 * `ReferenceError: webOS is not defined`: volume, mute, apps, network, all of
 * it, on the first run this adapter ever had outside a unit test.
 *
 * `WebOSServiceBridge` is the native object webOSTV.js is itself a wrapper
 * around, and it is present without shipping anything. Verified on the
 * simulator: a call to `luna://com.palm.connectionmanager/getStatus` comes back
 * with real connection state. So prefer the library when an app has bundled it,
 * and fall back to the bridge underneath rather than requiring it.
 *
 * If neither exists this is not a webOS runtime at all, and that is
 * `unsupported` rather than a failure worth retrying.
 */
function luna(uri: string, method: string, parameters: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (typeof webOS !== "undefined" && webOS?.service?.request) {
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
      return;
    }

    const Bridge = bridgeConstructor();
    if (!Bridge) {
      reject(new TvUnsupportedError(
        "no Luna service bridge on this build — the page has no webOSTV.js " +
        "(`webOS.service.request`) and no native WebOSServiceBridge/PalmServiceBridge",
      ));
      return;
    }

    try {
      const bridge = new Bridge();
      // The bus can simply not answer; without this the turn hangs to its own
      // budget with nothing to show for it.
      const timer = setTimeout(
        () => reject(new Error(`Luna call timed out after ${LUNA_TIMEOUT_MS}ms: ${uri}/${method}`)),
        LUNA_TIMEOUT_MS,
      );
      bridge.onservicecallback = (raw: string) => {
        clearTimeout(timer);
        let res: any;
        try {
          res = JSON.parse(raw);
        } catch {
          reject(new Error(`Luna returned something that isn't JSON: ${String(raw).slice(0, 120)}`));
          return;
        }
        // The bridge reports service-level failures in the payload, not by
        // throwing, so an unknown method would otherwise look like success
        // with every field undefined.
        if (res?.returnValue === false) {
          const text = String(res.errorText ?? `Luna error ${res.errorCode ?? "?"}`);
          // "Unknown method" and "Service does not exist" mean this build does
          // not offer the capability at all, which is `unsupported` — telling
          // the viewer "that didn't work" invites retrying something that never
          // will. Anything else (a real service saying no) stays a failure.
          reject(/unknown method|service does not exist/i.test(text)
            ? new TvUnsupportedError(`${text} — ${uri}/${method}`)
            : new Error(text));
          return;
        }
        resolve(res);
      };
      bridge.call(`${uri}/${method}`, JSON.stringify(parameters));
    } catch (e) {
      reject(e as Error);
    }
  });
}

function bridgeConstructor(): any {
  if (typeof WebOSServiceBridge !== "undefined") return WebOSServiceBridge;
  if (typeof PalmServiceBridge !== "undefined") return PalmServiceBridge;
  return undefined;
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
  const kv = createLocalStorageStore("hearth");

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
/** The variadic tail just swallows the unused args at each call site. */
function notSupported(what: string, ..._a: unknown[]): never { throw new TvUnsupportedError(what); }
