import {
  TvUnsupportedError,
  hasCapability,
  matchAppsByName, createLocalStorageStore, createWebSpeechPipeline,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey,
} from "@tv-ai-agent/platform-api";

/**
 * Titan OS adapter — **a stub, deliberately, and not an integration.**
 *
 * Titan OS runs HTML5 apps, so the runtime bundle in this repo lands there
 * unchanged; what is *not* public is the control surface. Volume, input
 * switching, app launching and power on a Titan device sit behind a partner SDK
 * we do not have documentation for. Guessing at API names would produce code
 * that looks finished, passes its own mocks, and fails on the first real device
 * in a way nobody can debug — so this file declares the *shape* of the bridge we
 * expect and refuses, in the typed way, until something implements it.
 *
 * That refusal is not a gap: `unsupported` is a first-class answer everywhere
 * above here. The capability probe withdraws what this device cannot back, the
 * planner routes around it, and the model is never offered a tool that would
 * fail. An agent on a bare Titan build can still hold a conversation and read
 * what little the browser exposes — which is exactly what it should do.
 *
 * The point of the stub is architectural: adding an OS must touch this package
 * and nothing else. No planner, no world model, no capability graph, no policy.
 * If bringing Titan up ever needs a change under `core/src/{world,planner,
 * capabilities,devices,policy}`, the abstraction is wrong and we want to know
 * before P3, not during it.
 *
 * To finish it: implement `TitanBridge` against the partner SDK, drop it on the
 * page as `window.TitanBridge`, and delete nothing here.
 */

/**
 * What we need from a Titan host. Every member is optional: an older or more
 * restricted build simply provides less, and the agent shrinks to fit.
 *
 * Modelled on the AOSP bridge, which is the same idea and has run on a device —
 * a small, synchronous-or-promise surface injected into the page, rather than an
 * SDK the app has to bundle.
 */
export interface TitanBridge {
  getDeviceInfo?(): { osVersion?: string; soc?: string; model?: string } | string;
  getVolume?(): number | Promise<number>;
  setVolume?(level: number): void | Promise<void>;
  getMute?(): boolean | Promise<boolean>;
  setMute?(mute: boolean): void | Promise<void>;
  getInputSource?(): string | Promise<string>;
  setInputSource?(source: string): void | Promise<void>;
  powerStandby?(): void | Promise<void>;
  listInstalledApps?(): AppEntry[] | string | Promise<AppEntry[] | string>;
  launchApp?(appId: string, params?: Record<string, string>): void | Promise<void>;
  getForegroundApp?(): AppEntry | string | null | Promise<AppEntry | string | null>;
  sendKey?(key: string): void | Promise<void>;
  isOnline?(): boolean | Promise<boolean>;
  connectionType?(): string | Promise<string>;
}

declare const TitanBridge: TitanBridge | undefined;

export interface TitanAdapterOptions {
  /** Injected by tests and by a host that gets the bridge some other way. */
  bridge?: TitanBridge;
}

export function createTitanAdapter(opts: TitanAdapterOptions = {}): PlatformProvider {
  const bridge = opts.bridge ?? (typeof TitanBridge !== "undefined" ? TitanBridge : undefined);

  /**
   * Call a bridge method, or refuse in the way the whole stack understands.
   *
   * One helper rather than a check per call site, because the interesting part of
   * each capability below should be the mapping, and because a missing method and
   * a missing bridge deserve the same answer: this device cannot do that, do not
   * retry, tell the user plainly.
   */
  const via = async <K extends keyof TitanBridge>(
    name: K,
    call: (fn: NonNullable<TitanBridge[K]>) => unknown,
  ): Promise<any> => {
    const fn = bridge?.[name];
    if (typeof fn !== "function") {
      throw new TvUnsupportedError(
        bridge
          ? `${String(name)} is not on this Titan build's bridge`
          : "no Titan bridge on this page — the Titan control SDK is not wired up yet",
      );
    }
    return await call(fn as NonNullable<TitanBridge[K]>);
  };

  const info = readInfo(bridge);
  const voice = createWebSpeechPipeline();
  const device: DeviceInfo = {
    os: "titan",
    osVersion: info.osVersion ?? "unknown",
    soc: info.soc ?? "unknown",
    model: info.model ?? "titan-tv",
    // Advertised per method, not per platform: two Titan builds can grant
    // different sets and `has()` cannot see inside a required member anyway.
    capabilities: {
      volume: typeof bridge?.getVolume === "function",
      apps: typeof bridge?.listInstalledApps === "function",
      input: typeof bridge?.getInputSource === "function",
      voice: voice !== undefined,
    },
  };

  const listApps = async (): Promise<AppEntry[]> => {
    const raw = await via("listInstalledApps", (fn) => fn());
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list as AppEntry[] : [];
  };

  const provider: PlatformProvider = {
    device,
    voice,
    system: {
      getVolume: async () => clamp(Number(await via("getVolume", (fn) => fn()))),
      setVolume: async (level) => { await via("setVolume", (fn) => fn(clamp(level))); },
      getMute: async () => Boolean(await via("getMute", (fn) => fn())),
      setMute: async (mute) => { await via("setMute", (fn) => fn(mute)); },
      getInputSource: async () => String(await via("getInputSource", (fn) => fn())) as InputSource,
      setInputSource: async (source) => { await via("setInputSource", (fn) => fn(source)); },
      powerStandby: async () => { await via("powerStandby", (fn) => fn()); },
    },
    apps: {
      listInstalledApps: listApps,
      launchApp: async (appId, params) => { await via("launchApp", (fn) => fn(appId, params)); },
      getForegroundApp: async () => {
        const raw = await via("getForegroundApp", (fn) => fn());
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return (parsed && typeof parsed === "object" ? parsed as AppEntry : null);
      },
      findAppsByName: async (query) => matchAppsByName(await listApps(), query),
    },
    navigation: {
      sendKey: async (key: RemoteKey) => { await via("sendKey", (fn) => fn(key)); },
      isAvailable: async () => typeof bridge?.sendKey === "function",
    },
    network: {
      // The browser answers this on any HTML5 TV, so a missing bridge method is
      // not a reason to know nothing about the network.
      isOnline: async () => {
        if (typeof bridge?.isOnline === "function") return Boolean(await bridge.isOnline());
        return typeof navigator === "undefined" ? true : navigator.onLine !== false;
      },
      connectionType: async () => {
        if (typeof bridge?.connectionType !== "function") return "ethernet";
        const type = String(await bridge.connectionType()).toLowerCase();
        return type.includes("wifi") || type.includes("wireless") ? "wifi"
          : type.includes("none") || type.includes("off") ? "none"
          : "ethernet";
      },
    },
    storage: createLocalStorageStore("tv-ai-agent"),
    has: (cap) => hasCapability(provider, cap),
    init: async () => { /* nothing to wire until there is a real bridge */ },
  };
  return provider;
}

function readInfo(bridge?: TitanBridge): { osVersion?: string; soc?: string; model?: string } {
  try {
    const raw = bridge?.getDeviceInfo?.();
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function clamp(level: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(level) ? level : 0)));
}
