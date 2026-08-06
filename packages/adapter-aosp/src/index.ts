import {
  hasCapability,
  matchAppsByName,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey, type VoicePipeline,
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
  // Voice. Optional so an older host APK still works with a newer bundle.
  ttsAvailable?(): boolean;
  speak?(text: string): void;
  stopSpeaking?(): void;
  sttAvailable?(): boolean;
  sttUnavailableReason?(): string;
  requestMicPermission?(): void;
  startListening?(): void;
  stopListening?(): void;
}

/**
 * Events the native side pushes into the page, because recognition results
 * arrive whenever the user stops talking rather than when JS asks.
 */
type VoiceEvent =
  | { type: "listening" }
  | { type: "stopped" }
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "level"; level: number }
  | { type: "speakStart" }
  | { type: "speakDone"; spoken: boolean }
  | { type: "micPermission"; granted: boolean }
  | { type: "error"; message: string };

export function createAospAdapter(): PlatformProvider {
  // Read the injected interface off globalThis: a bare `TvNativeBridge`
  // reference throws a bare ReferenceError when the host hasn't installed it
  // (plain browser, or the bundle ran before addJavascriptInterface), which
  // would hide the actionable message below.
  const bridge = (globalThis as { TvNativeBridge?: NativeBridge }).TvNativeBridge;
  if (!bridge) throw new Error("TvNativeBridge not found — are you running inside the AOSP host WebView?");

  const info = JSON.parse(bridge.getDeviceInfo()) as Partial<DeviceInfo>;

  // Attached only when the host APK actually offers it, so `has("voice")` answers
  // honestly and an older APK paired with a newer bundle degrades to text rather
  // than throwing on the first spoken command.
  const voice = createVoicePipeline(bridge);

  const device: DeviceInfo = {
    os: "aosp",
    osVersion: info.osVersion ?? "unknown",
    soc: info.soc ?? "unknown",
    model: info.model ?? "unknown",
    capabilities: {
      ...(info.capabilities ?? { media: true, voice: false }),
      voice: voice !== undefined,
    },
  };

  const provider: PlatformProvider = {
    device,
    system: {
      getVolume: async () => bridge.getVolume(),
      setVolume: async (l) => bridge.setVolume(clamp(l)),
      getMute: async () => bridge.getMute(),
      setMute: async (m) => bridge.setMute(m),
      getInputSource: async () => bridge.getInputSource() as InputSource,
      setInputSource: async (s) => {
        callNative("setInputSource (needs a platform signature on most builds)", () => bridge.setInputSource(s));
      },
      powerStandby: async () => {
        callNative("powerStandby (needs the DEVICE_POWER system permission)", () => bridge.powerStandby());
      },
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
      sendKey: async (k: RemoteKey) => {
        const enabled = bridge.isAccessibilityEnabled?.() ?? false;
        callNative(
          enabled
            ? `key '${k}' via accessibility (not every key is reachable this way)`
            : "navigation — enable the accessibility service first (navigation.requestSetup)",
          () => bridge.sendKey(k),
        );
      },
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
    ...(voice ? { voice } : {}),
    has: (cap) => hasCapability(provider, cap),
    init: async () => { /* bridge is ready once WebView finished loading */ },
  };
  return provider;
}

/**
 * Bridge the native speech APIs onto `VoicePipeline`.
 *
 * Native pushes events into `window.__tvVoice` rather than returning them,
 * because recognition finishes whenever the speaker does. The subscriber list
 * lives here so several listeners (the agent, the avatar's mouth) can share one
 * recognizer — Android allows only one at a time.
 */
function createVoicePipeline(bridge: NativeBridge): VoicePipeline | undefined {
  if (!bridge.startListening || !bridge.speak) return undefined;

  const transcriptSubs = new Set<(text: string, isFinal: boolean) => void>();
  const endSubs = new Set<() => void>();
  let levelSub: ((level: number) => void) | undefined;
  let onSpeakDone: (() => void) | undefined;

  (globalThis as { __tvVoice?: { onEvent(e: VoiceEvent): void } }).__tvVoice = {
    onEvent: (event) => {
      switch (event.type) {
        case "transcript":
          transcriptSubs.forEach((cb) => cb(event.text, event.isFinal));
          break;
        case "level":
          levelSub?.(event.level);
          break;
        case "stopped":
          // Native emits this after a result *and* after an error, so it is the
          // one reliable "the attempt is over" signal. It used to be dropped
          // here, which left every unsuccessful attempt looking like it was
          // still listening — and the caller's flag stuck, so the next press did
          // nothing.
          endSubs.forEach((cb) => cb());
          break;
        case "speakDone":
          onSpeakDone?.();
          onSpeakDone = undefined;
          break;
        case "error":
          // Not thrown: a failed recognition attempt must not break a turn, and
          // "didn't catch that" is a normal outcome rather than a fault.
          console.warn(`[aosp] voice: ${event.message}`);
          break;
        default:
          break;
      }
    },
  };

  return {
    startListening: async () => {
      // Asking is idempotent and returns immediately when already granted; the
      // native side reports the outcome through `micPermission`.
      if (!(bridge.sttAvailable?.() ?? false)) bridge.requestMicPermission?.();
      bridge.startListening!();
    },
    stopListening: async () => bridge.stopListening?.(),
    onTranscript: (cb) => {
      transcriptSubs.add(cb);
      return () => { transcriptSubs.delete(cb); };
    },
    onListeningEnd: (cb) => {
      endSubs.add(cb);
      return () => { endSubs.delete(cb); };
    },
    speak: async (text) =>
      new Promise<void>((resolve) => {
        // Resolve on the native `speakDone`, so callers can tell when the TV has
        // actually stopped talking — that's what drives the avatar's mouth.
        onSpeakDone = resolve;
        bridge.speak!(text);
      }),
  };
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Call a bridge method that may legitimately be unavailable.
 *
 * Android replaces anything thrown inside a `@JavascriptInterface` method with a
 * generic "Java exception was raised during method invocation" — the Kotlin
 * side's message never crosses the bridge. Without this, a known-unavailable
 * capability looks like a hard error to the agent and shows up red in the
 * bring-up report instead of as "unsupported". So we supply the reason here,
 * where we still know it, in the "Not supported: …" form the HAL expects.
 */
function callNative(reason: string, fn: () => void): void {
  try {
    fn();
  } catch {
    throw new Error(`Not supported: ${reason}`);
  }
}
