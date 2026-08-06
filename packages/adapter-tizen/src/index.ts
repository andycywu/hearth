import {
  hasCapability,
  matchAppsByName, createLocalStorageStore, createWebSpeechPipeline,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey, type KeyValueStore,
} from "@tv-ai-agent/platform-api";

/**
 * Tizen adapter. On Samsung/NVT/MTK Tizen builds the runtime is a packaged web
 * app (.wgt) that can call the global `tizen.*` Web Device APIs (declared in
 * config.xml privileges). This file maps the HAL onto those APIs.
 *
 * NOTE: `tizen` and `webapis` are injected globals on-device. They are typed as
 * `any` here to avoid a hard build dependency on the Tizen type packages; real
 * device builds should add @types for stricter checking. Where an API is not
 * available on a given SoC/firmware, methods throw "not supported" so the agent
 * can degrade gracefully via PlatformProvider.has().
 */
declare const tizen: any;
declare const webapis: any;

export function createTizenAdapter(): PlatformProvider {
  const kv = tizenKeyValueStore();

  /**
   * Tizen's WebView is Chromium, and the TV 10.0 emulator turned out to expose
   * `speechSynthesis` and `webkitSpeechRecognition` — so voice here needs no
   * native code and no Samsung partner agreement, which is not what I expected.
   * Feature-detected, so a firmware without them reports no voice rather than
   * advertising one that throws. See `?diag`'s `voice.engines` row.
   */
  const voice = createWebSpeechPipeline();

  const device: DeviceInfo = {
    os: "tizen",
    osVersion: safe(() => webapis?.productinfo?.getVersion?.()) ?? "unknown",
    soc: detectSoc(),
    model: safe(() => webapis?.productinfo?.getModel?.()) ?? "unknown",
    capabilities: { media: true, voice: voice !== undefined },
  };

  const provider: PlatformProvider = {
    device,
    system: {
      getVolume: async () => Number(audio().getVolume()),
      setVolume: async (l) => audio().setVolume(clamp(l)),
      getMute: async () => Boolean(safe(() => webapis?.audiocontrol?.getMute?.()) ?? false),
      setMute: async (m) => audio().setMute(m),
      getInputSource: async () => mapTizenSource(safe(() => webapis?.tvinfo?.getCurrentSource?.())),
      setInputSource: async (s) => { notSupported("setInputSource on this firmware", s); },
      powerStandby: async () => { notSupported("powerStandby"); },
    },
    apps: {
      listInstalledApps: listApps,
      launchApp: async (id) =>
        new Promise<void>((resolve, reject) => {
          tizen.application.launch(id, () => resolve(), (e: any) => reject(new Error(String(e?.message ?? e))));
        }),
      getForegroundApp: async () => {
        const ctx = safe(() => tizen.application.getCurrentApplication().appInfo);
        return ctx ? { id: ctx.id, name: ctx.name } : null;
      },
      findAppsByName: async (q) => matchAppsByName(await listApps(), q),
    },
    navigation: {
      sendKey: async (k: RemoteKey) => {
        // Tizen apps drive their own DOM focus; here we dispatch a synthetic key
        // event to the document so the web UI reacts to the agent like a remote.
        dispatchKey(k);
      },
    },
    network: {
      // Without Samsung's webapis this used to answer a hardcoded `true`, which
      // reported "online" on an emulator that couldn't reach anything at all —
      // exactly the wrong answer, since the agent uses it to decide whether to
      // try the model. `navigator.onLine` is the standard fallback and is at
      // least measuring something.
      isOnline: async () => {
        const gateway = safe(() => webapis?.network?.isConnectedToGateway?.());
        if (typeof gateway === "boolean") return gateway;
        // What the TV itself thinks, before falling back to the browser's view.
        const type = await networkType();
        if (type) return type !== "NONE";
        return typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
          ? navigator.onLine
          : true;
      },
      connectionType: async () => {
        const t = safe(() => webapis?.network?.getActiveConnectionType?.());
        if (t === 0) return "wifi";
        if (t === 1) return "ethernet";
        // Standard Tizen again, so this reports the truth on builds without
        // Samsung's extension instead of flatly answering "none".
        const type = await networkType();
        if (type === "WIFI") return "wifi";
        if (type === "ETHERNET") return "ethernet";
        return "none";
      },
    },
    storage: kv,
    ...(voice ? { voice } : {}),
    media: {
      // Media transport on Tizen is typically driven by the app's own AVPlay /
      // <video> element; the agent injects the corresponding remote keys so the
      // active player reacts. Adapters with a managed player can override this.
      play: async (_uri) => dispatchKey("playpause"),
      pause: async () => dispatchKey("playpause"),
      resume: async () => dispatchKey("playpause"),
      seek: async (_ms) => { /* app-managed; no generic Tizen seek API */ },
    },
    has: (cap) => hasCapability(provider, cap),
    init: async () => {
      // Fill in the device info Samsung's webapis would have given us. This is
      // the standard Tizen API, so it works on builds without the proprietary
      // extension — including the TV emulator, where webapis is absent and the
      // status line otherwise reads "unknown · tizen unknown · soc=unknown".
      await refreshDeviceInfo(device);
    },
  };
  return provider;

  function listApps(): Promise<AppEntry[]> {
    return new Promise<AppEntry[]>((resolve, reject) => {
      tizen.application.getAppsInfo(
        (list: any[]) => resolve(list.map((a) => ({ id: a.id, name: a.name, version: a.version }))),
        (e: any) => reject(new Error(String(e?.message ?? e))),
      );
    });
  }
}

/**
 * Volume control, from whichever API this build actually has.
 *
 * `webapis.audiocontrol` is Samsung's, and it is the one that works on retail
 * Samsung TVs — but it is a proprietary extension loaded by the host page from
 * `$WEBAPIS`, and it is simply absent on some builds, the TV emulator included.
 * `tizen.tvaudiocontrol` is the standard Tizen TV API and covers those.
 *
 * Prefer Samsung's where present, since that's the retail target, and say
 * something useful when neither exists rather than dying with "cannot read
 * property of undefined" — a message that tells you nothing from a TV you can't
 * attach a debugger to. `?diag` reports this sentence verbatim.
 */
function audio(): any {
  const samsung = typeof webapis !== "undefined" ? webapis?.audiocontrol : undefined;
  if (samsung) return samsung;
  const standard = typeof tizen !== "undefined" ? (tizen as any)?.tvaudiocontrol : undefined;
  if (standard) return standard;
  throw new Error(
    "no audio control API on this build — neither Samsung's webapis.audiocontrol " +
    '(host page needs <script src="$WEBAPIS/webapis/webapis.js">) nor tizen.tvaudiocontrol',
  );
}

/**
 * Device model and OS version via the standard `tizen.systeminfo`, which exists
 * whether or not the proprietary webapis does. Best-effort: an unnamed TV is
 * not worth failing a boot over, so anything missing just stays "unknown".
 */
async function refreshDeviceInfo(device: DeviceInfo): Promise<void> {
  const build = await systemInfo("BUILD");
  if (build) {
    const model = str(build.model) ?? str(build.buildVersion);
    if (model) {
      device.model = model;
      device.soc = socFromModel(model) ?? device.soc;
    }
    const version = str(build.buildVersion);
    if (version) device.osVersion = version;
  }
  // Samsung's own numbers are better when they're there.
  const samsungModel = safe(() => webapis?.productinfo?.getModel?.());
  if (str(samsungModel)) {
    device.model = String(samsungModel);
    device.soc = socFromModel(String(samsungModel)) ?? device.soc;
  }
  const samsungVersion = safe(() => webapis?.productinfo?.getVersion?.());
  if (str(samsungVersion)) device.osVersion = String(samsungVersion);
}

/** "NONE" | "WIFI" | "ETHERNET" | … as the TV OS reports it, or undefined. */
async function networkType(): Promise<string | undefined> {
  const net = await systemInfo("NETWORK");
  return str(net?.networkType);
}

function systemInfo(property: string): Promise<any | undefined> {
  return new Promise((resolve) => {
    try {
      tizen.systeminfo.getPropertyValue(property, (v: unknown) => resolve(v), () => resolve(undefined));
    } catch {
      resolve(undefined);
    }
  });
}

function str(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
}

function detectSoc(): string {
  return socFromModel(safe(() => webapis?.productinfo?.getModel?.()) ?? "") ?? "unknown";
}

function socFromModel(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.includes("mtk") || m.includes("mediatek")) return "mediatek";
  if (m.includes("nvt") || m.includes("novatek")) return "novatek";
  return undefined;
}

const TIZEN_KEYCODES: Partial<Record<RemoteKey, number>> = {
  up: 38, down: 40, left: 37, right: 39, ok: 13, back: 10009, home: 10071,
  playpause: 10252, stop: 413, rewind: 412, fastforward: 417,
  channelup: 427, channeldown: 428, menu: 18,
};
function dispatchKey(k: RemoteKey): void {
  const keyCode = TIZEN_KEYCODES[k];
  if (keyCode == null || typeof document === "undefined") return;
  document.dispatchEvent(new KeyboardEvent("keydown", { keyCode } as any));
}
function mapTizenSource(_raw: unknown): InputSource { return "tv"; }
/**
 * Prefer Tizen's own `preference` API — it is the only store that survives an
 * app *reinstall* as well as a restart — and fall back to localStorage, then
 * memory. This used to be a bare `Map`, which meant `Agent`'s `persistKey`
 * quietly did nothing on a real TV.
 */
function tizenKeyValueStore(): KeyValueStore {
  const fallback = createLocalStorageStore("tv-ai-agent");
  const preference = safe(() => tizen?.preference) as
    | { setValue(k: string, v: string): void; getValue(k: string): unknown;
        remove(k: string): void; exists(k: string): boolean }
    | undefined;
  if (!preference) return fallback;

  return {
    get: async (k) => {
      try {
        return preference.exists(k) ? String(preference.getValue(k)) : null;
      } catch {
        return fallback.get(k);
      }
    },
    set: async (k, v) => {
      try {
        preference.setValue(k, v);
      } catch {
        await fallback.set(k, v);
      }
    },
    delete: async (k) => {
      try {
        if (preference.exists(k)) preference.remove(k);
      } catch {
        await fallback.delete(k);
      }
    },
  };
}
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
function safe<T>(fn: () => T): T | undefined { try { return fn(); } catch { return undefined; } }
function notSupported(what: string, ..._a: unknown[]): never { throw new Error(`Not supported: ${what}`); }
