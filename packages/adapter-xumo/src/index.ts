import {
  TvUnsupportedError,
  hasCapability,
  matchAppsByName, createLocalStorageStore, createWebSpeechPipeline,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey,
} from "@hearthkit/platform-api";

/**
 * Xumo adapter — **a stub, deliberately, and not an integration.**
 *
 * Xumo TV is an RDK-based platform, and a third-party app there talks to the
 * platform through **Firebolt** rather than through anything TV-shaped. What
 * Firebolt gives an app is device identity, lifecycle, localization, discovery
 * and advertising context. What it does not hand out is the set this HAL is built
 * around: volume, mute, input switching and launching another app are the
 * platform's business, not an app's, and on a retail device an app asking for
 * them should be refused.
 *
 * *(Treat that paragraph as the current understanding, not as verified fact. It
 * needs checking against Firebolt's published API for the target release and
 * against what a Xumo partner build actually grants. The stub is written so that
 * being wrong about it costs one file.)*
 *
 * Which makes Xumo the most useful stub in the repo, because it is the case the
 * architecture has to survive: a platform where **most of the TV control surface
 * is simply not ours**, and the agent's value has to come from somewhere else —
 * the world model, the device graph, content providers, reasoning over what it
 * *can* reach. An adapter that pretended otherwise would produce a launcher
 * competing with a mature one; this one degrades to what it is allowed to do and
 * lets the capability probe tell the truth about the rest.
 *
 * The architectural point is the same as Titan's: adding an OS touches this
 * package and nothing else. No planner, no world model, no capability graph, no
 * policy.
 *
 * To finish it: implement `XumoBridge` over the Firebolt SDK (or whatever the
 * partner surface turns out to be) and pass it in.
 */

/**
 * What we need from a Xumo/RDK host.
 *
 * Everything optional, and the comments record which Firebolt-ish module would
 * plausibly back each one — a note for whoever wires this up, not a claim that
 * the mapping is confirmed.
 */
export interface XumoBridge {
  /** `Device.model()` / `Device.version()` / `Device.platform()`. */
  getDeviceInfo?(): { osVersion?: string; soc?: string; model?: string } | string;
  /** Almost certainly platform-privileged; expected to be absent. */
  getVolume?(): number | Promise<number>;
  setVolume?(level: number): void | Promise<void>;
  getMute?(): boolean | Promise<boolean>;
  setMute?(mute: boolean): void | Promise<void>;
  /** An app does not switch the TV's input. Expected to be absent. */
  getInputSource?(): string | Promise<string>;
  setInputSource?(source: string): void | Promise<void>;
  /** Launching another app is a platform action, not an app one. */
  listInstalledApps?(): AppEntry[] | string | Promise<AppEntry[] | string>;
  launchApp?(appId: string, params?: Record<string, string>): void | Promise<void>;
  /** `Device.network()` — reachable from an app. */
  isOnline?(): boolean | Promise<boolean>;
  connectionType?(): string | Promise<string>;
  /** Key handling is the app's own; injecting into other apps is not. */
  sendKey?(key: string): void | Promise<void>;
}

declare const XumoBridge: XumoBridge | undefined;

export interface XumoAdapterOptions {
  bridge?: XumoBridge;
}

export function createXumoAdapter(opts: XumoAdapterOptions = {}): PlatformProvider {
  const bridge = opts.bridge ?? (typeof XumoBridge !== "undefined" ? XumoBridge : undefined);

  /**
   * Call a bridge method, or refuse in the typed way.
   *
   * The message distinguishes "this platform does not give apps that" from "no
   * bridge here at all", because the first is permanent and correct and the
   * second is something an integrator can fix. Both are `unsupported`; only the
   * sentence differs, and that sentence is what ends up in `?diag`.
   */
  const via = async <K extends keyof XumoBridge>(
    name: K,
    call: (fn: NonNullable<XumoBridge[K]>) => unknown,
  ): Promise<any> => {
    const fn = bridge?.[name];
    if (typeof fn !== "function") {
      throw new TvUnsupportedError(
        bridge
          ? `${String(name)} isn't available to an app on this platform`
          : "no Xumo bridge on this page — the platform surface is not wired up yet",
      );
    }
    return await call(fn as NonNullable<XumoBridge[K]>);
  };

  const info = readInfo(bridge);
  const voice = createWebSpeechPipeline();
  const device: DeviceInfo = {
    os: "xumo",
    osVersion: info.osVersion ?? "unknown",
    soc: info.soc ?? "unknown",
    model: info.model ?? "xumo-tv",
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
      // Never plausible from an app, and there is no bridge member for it: an
      // app that could put the television into standby is a bug report.
      powerStandby: async () => {
        throw new TvUnsupportedError("an app can't put this TV into standby");
      },
    },
    apps: {
      listInstalledApps: listApps,
      launchApp: async (appId, params) => { await via("launchApp", (fn) => fn(appId, params)); },
      // Reachable in principle through the platform's own lifecycle/discovery,
      // but not through anything we have: answering `null` would claim to know
      // that nothing is in the foreground, which is not the same as not knowing.
      getForegroundApp: async () => {
        throw new TvUnsupportedError("this platform doesn't tell an app what else is running");
      },
      findAppsByName: async (query) => matchAppsByName(await listApps(), query),
    },
    navigation: {
      sendKey: async (key: RemoteKey) => { await via("sendKey", (fn) => fn(key)); },
      isAvailable: async () => typeof bridge?.sendKey === "function",
    },
    network: {
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
    storage: createLocalStorageStore("hearth"),
    has: (cap) => hasCapability(provider, cap),
    init: async () => { /* nothing to wire until there is a real bridge */ },
  };
  return provider;
}

function readInfo(bridge?: XumoBridge): { osVersion?: string; soc?: string; model?: string } {
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
