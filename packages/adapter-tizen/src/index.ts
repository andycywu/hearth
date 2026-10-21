import {
  TvUnsupportedError,
  hasCapability,
  matchAppsByName, createLocalStorageStore, createWebSpeechPipeline,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey, type KeyValueStore,
} from "@hearthkit/platform-api";

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

/**
 * What happens after a successful input switch.
 *
 * `tizen.tvwindow.setSource` changes the source of the television's MAIN video window. A web app is drawn *over* that window, so
 * after `setSource` alone the person still sees the app (measured on an HKC Tizen 7.0 set, 2026-10-21: the television reported
 * HDMI 1 and the owner saw only the app's page). The picture appears when the television's own viewer is brought to the front,
 * which is what Samsung's launcher-style apps do after `setSource` — and launching another application suspends this page, so it
 * is done *after* the switch has been read back and after the agent has had a moment to say what it did.
 */
export interface TizenInputOptions {
  /** `false` leaves the page in front: the source changes, and nothing shows it. Default: bring the viewer up. */
  showAfterSwitch?: false | {
    /** The television's viewer. Default `org.tizen.tv-viewer`. */
    appId?: string;
    /** How long after the switch is confirmed to launch it, so the read-back and the reply can happen first. Default 2500 ms. */
    delayMs?: number;
  };
}

export interface TizenAdapterOptions {
  input?: TizenInputOptions;
}

export function createTizenAdapter(options: TizenAdapterOptions = {}): PlatformProvider {
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
      // Through `audio()` like the other three, so a build with no audio API
      // says so. It used to swallow the failure and answer `false`, which meant
      // "is the TV muted?" got a confident "no" from a TV that cannot tell —
      // and `getVolume` on the same build threw. One of those was wrong.
      getMute: async () => readMute(),
      setMute: async (m) => audio().setMute(m),
      getInputSource: async () => readInputSource(),
      setInputSource: async (s) => switchInputSource(s, options.input),
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
  // Typed, not a plain Error: this firmware genuinely has no audio API, so it is
  // *unsupported* rather than a failure worth retrying. As a plain Error it
  // reached the viewer as "That didn't work" — advice to try again at something
  // that can never work. Caught on the Tizen emulator, where neither API exists.
  throw new TvUnsupportedError(
    "no audio control API on this build — neither Samsung's webapis.audiocontrol " +
    '(host page needs <script src="$WEBAPIS/webapis/webapis.js">) nor tizen.tvaudiocontrol',
  );
}

/**
 * Is the television muted — asked in whichever of the two spellings this build
 * understands.
 *
 * The two APIs do not agree on the name. Samsung's `webapis.audiocontrol` has
 * `getMute()`; the standard `tizen.tvaudiocontrol` calls the same question
 * `isMute()` and has no `getMute` at all. Everything else this adapter needs is
 * spelled identically in both, which is exactly why this one was missed: the
 * code read `getMute()` off whichever object `audio()` returned, and no image
 * this project had run on carried *either* API, so it had never executed.
 *
 * It executed for the first time on an HKC-built Tizen 7.0 television
 * (2026-09-14) and answered `TypeError: (...).getMute is not a function` — a
 * failure, from a set that was perfectly able to answer the question. Asked by
 * name rather than by API, because a build can carry either one.
 */
function readMute(): boolean {
  const api = audio();
  if (typeof api.getMute === "function") return Boolean(api.getMute());
  if (typeof api.isMute === "function") return Boolean(api.isMute());
  throw new TvUnsupportedError(
    "this audio API has neither getMute() (Samsung's webapis.audiocontrol) nor " +
    "isMute() (the standard tizen.tvaudiocontrol)",
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
// ---- input source ----------------------------------------------------------------------------------------------------------
//
// Until 2026-10-21 this adapter answered "tv" to every read (it called webapis.tvinfo.getCurrentSource, which does not exist on the one
// set it has met, and threw the answer away) and refused every write without calling anything — and the documentation called that
// "signing-gated". Neither was measured. A page signed with an ordinary developer certificate, declaring tv.window, reads the source
// with tizen.tvwindow.getSource() and switches it with setSource on an HKC Tizen 7.0 set; see tools/experiments/tizen-input-probe and
// docs/platform/free-my-tv-reference.md.

interface TizenSource { type: string; number: number; [k: string]: unknown }

/** The VIDEOSOURCE type names the television uses, against ours. */
const TYPE_TO_INPUT: Record<string, (n: number) => InputSource | undefined> = {
  HDMI: (n) => (n >= 1 && n <= 4 ? (`hdmi${n}` as InputSource) : undefined),
  TV: () => "tv",
  AV: () => "av",
  COMPONENT: () => "component",
};

function tvWindow(): any {
  const w = typeof tizen !== "undefined" ? tizen?.tvwindow : undefined;
  if (w && typeof w.getSource === "function") return w;
  throw new TvUnsupportedError(
    "input source — this build has no tizen.tvwindow (the page needs the http://tizen.org/privilege/tv.window privilege in config.xml)",
  );
}

/** What the television reports it is showing in its main window, as one of our ids — or an error that says what it saw. */
function readInputSource(): InputSource {
  const w = tvWindow();
  let raw: TizenSource | undefined;
  try {
    raw = w.getSource("MAIN");
  } catch (e) {
    throw sourceError("read the input source", e);
  }
  const mapped = raw ? TYPE_TO_INPUT[String(raw.type).toUpperCase()]?.(Number(raw.number)) : undefined;
  if (!mapped) {
    throw new Error(`the television reported an input this adapter has no name for: ${JSON.stringify(raw)}`);
  }
  return mapped;
}

function inputToTizen(source: InputSource): { type: string; number: number } {
  const hdmi = /^hdmi([1-4])$/.exec(source);
  if (hdmi) return { type: "HDMI", number: Number(hdmi[1]) };
  if (source === "tv") return { type: "TV", number: 1 };
  if (source === "av") return { type: "AV", number: 1 };
  if (source === "component") return { type: "COMPONENT", number: 1 };
  throw new TvUnsupportedError(`input ${source} — not a source the television's main window can show`);
}

/** Every source the television lists, with a signal or without: a port with nothing on it is still a port it can be put on. */
function listSources(): Promise<TizenSource[]> {
  return new Promise((resolve, reject) => {
    try {
      tizen.systeminfo.getPropertyValue(
        "VIDEOSOURCE",
        (v: any) => resolve([...(v?.connected ?? []), ...(v?.disconnected ?? [])]),
        (e: any) => reject(sourceError("list the input sources", e)),
      );
    } catch (e) {
      reject(sourceError("list the input sources", e));
    }
  });
}

/**
 * A privilege the page was not given is the platform saying no, which is `unsupported`; anything else is a switch that was asked for
 * and did not happen, which is `failed`. The television's own words (name and message) stay in the text.
 */
function sourceError(doing: string, e: any): Error {
  const name = String(e?.name ?? "Error");
  const text = `could not ${doing}: ${name}: ${String(e?.message ?? e)}`;
  return name === "SecurityError" || name === "NotSupportedError" ? new TvUnsupportedError(text) : new Error(text);
}

async function switchInputSource(source: InputSource, options: TizenInputOptions | undefined): Promise<void> {
  const w = tvWindow();
  if (typeof w.setSource !== "function") throw new TvUnsupportedError("input source — tizen.tvwindow has no setSource on this build");
  const wanted = inputToTizen(source);
  const listed = (await listSources()).find((x) => String(x.type).toUpperCase() === wanted.type && Number(x.number) === wanted.number);
  if (!listed) throw new TvUnsupportedError(`input ${source} — this television does not list it`);

  await new Promise<void>((resolve, reject) => {
    try {
      w.setSource(listed, () => resolve(), (e: any) => reject(sourceError(`switch to ${source}`, e)));
    } catch (e) {
      reject(sourceError(`switch to ${source}`, e));
    }
  });

  // The television's success callback is its word that it did something. Ask what it is showing now before saying so.
  const now = readInputSource();
  if (now !== source) {
    throw new Error(`asked the television for ${source}; it reports ${now}`);
  }

  if (options?.showAfterSwitch !== false) {
    const appId = options?.showAfterSwitch?.appId ?? "org.tizen.tv-viewer";
    const delay = options?.showAfterSwitch?.delayMs ?? 2500;
    // Last, because this suspends the page. A launch that fails leaves the source switched and the picture hidden behind the app.
    setTimeout(() => {
      safe(() => tizen.application.launch(appId, () => {}, () => {}));
    }, delay);
  }
}
/**
 * Prefer Tizen's own `preference` API — it is the only store that survives an
 * app *reinstall* as well as a restart — and fall back to localStorage, then
 * memory. This used to be a bare `Map`, which meant `Agent`'s `persistKey`
 * quietly did nothing on a real TV.
 */
function tizenKeyValueStore(): KeyValueStore {
  const fallback = createLocalStorageStore("hearth");
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
/** The variadic tail just swallows the unused args at each call site. */
function notSupported(what: string, ..._a: unknown[]): never { throw new TvUnsupportedError(what); }
