/**
 * @tv-ai-agent/platform-api
 *
 * The Platform Abstraction Layer (HAL). Every capability the agent needs from
 * the TV is expressed here as a stable, platform-neutral interface. Concrete
 * adapters (Tizen, AOSP, web/mock) implement `PlatformProvider`. The agent core
 * only ever talks to these interfaces — never to `tizen.*` or Android bridges
 * directly — which is what makes the runtime portable across OS and SoC.
 */

export interface DeviceInfo {
  os: "aosp" | "tizen" | "webos" | "web";
  osVersion: string;
  /** SoC vendor, e.g. "mediatek" | "novatek" | "unknown". */
  soc: string;
  model: string;
  /** Free-form capability flags reported by the adapter. */
  capabilities: Record<string, boolean>;
}

export type InputSource =
  | "hdmi1" | "hdmi2" | "hdmi3" | "hdmi4"
  | "tv" | "av" | "component" | "usb" | "app";

export interface SystemControl {
  getVolume(): Promise<number>;               // 0..100
  setVolume(level: number): Promise<void>;
  getMute(): Promise<boolean>;
  setMute(mute: boolean): Promise<void>;
  getInputSource(): Promise<InputSource>;
  setInputSource(source: InputSource): Promise<void>;
  powerStandby(): Promise<void>;
}

export interface AppControl {
  listInstalledApps(): Promise<AppEntry[]>;
  launchApp(appId: string, params?: Record<string, string>): Promise<void>;
  getForegroundApp(): Promise<AppEntry | null>;
  /**
   * Fuzzy lookup by display name (case-insensitive substring). Default
   * implementations can be derived from listInstalledApps(); provided on the
   * interface so the agent can resolve "open Netflix" without knowing app ids.
   */
  findAppsByName(query: string): Promise<AppEntry[]>;
}

export interface AppEntry {
  id: string;
  name: string;
  version?: string;
}

/** Directional / media keys the agent can inject to drive the 10-foot UI. */
export type RemoteKey =
  | "up" | "down" | "left" | "right" | "ok" | "back" | "home"
  | "playpause" | "stop" | "rewind" | "fastforward"
  | "channelup" | "channeldown" | "menu";

export interface Navigation {
  sendKey(key: RemoteKey): Promise<void>;
  /**
   * Whether key navigation is currently usable. On AOSP this reflects whether
   * the user-enabled AccessibilityService is connected; platforms that always
   * support navigation may omit it (treated as available).
   */
  isAvailable?(): Promise<boolean>;
  /**
   * Trigger any one-time setup the user must complete to enable navigation
   * (e.g. open the Android accessibility settings). No-op where not needed.
   */
  requestSetup?(): Promise<void>;
}

export interface MediaControl {
  play(uri: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
}

export interface NetworkInfo {
  isOnline(): Promise<boolean>;
  connectionType(): Promise<"wifi" | "ethernet" | "none">;
}

/** Optional voice pipeline hooks; adapters may leave these unimplemented. */
export interface VoicePipeline {
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  onTranscript(cb: (text: string, isFinal: boolean) => void): () => void;
  /**
   * Fires when a recognition attempt finishes, for *any* reason — a result, no
   * match, silence, a timeout, an error.
   *
   * Without this there was no way to know an attempt was over unless it produced
   * a transcript, so anything else left the UI listening forever: the microphone
   * had closed, the avatar was still pulsing, and the caller's own "am I
   * listening" flag stayed set, which made the next press a no-op. Voice was dead
   * until the app was relaunched. `startListening` resolving doesn't help — it
   * returns as soon as the request is handed over, not when the attempt ends.
   *
   * Optional so an adapter that genuinely can't tell still satisfies the
   * contract; callers should keep a timeout for those.
   */
  onListeningEnd?(cb: () => void): () => void;
  speak(text: string): Promise<void>;
  /**
   * Optional hands-free wake word. Listens continuously for `phrase`; when heard,
   * `onWake` fires (the adapter stops wake listening so a command can be
   * captured). Adapters without wake support omit these.
   */
  startWakeWord?(phrase: string, onWake: () => void): Promise<void>;
  stopWakeWord?(): Promise<void>;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export { assertProviderContract } from "./contract.js";
export type { ContractOptions } from "./contract.js";
export { createLocalStorageStore, createMemoryStore } from "./storage.js";
export { createWebSpeechPipeline } from "./web-speech.js";
export { detectSpeechEngines } from "./speech-engines.js";
export { TvUnsupportedError, isTvUnsupported } from "./errors.js";

/**
 * The one rule for `has()`: a capability exists when its slot is filled.
 *
 * All four adapters had this same line copied in, each with its own `as any`
 * cast — the kind of duplication that stays right by luck. An adapter now writes
 * `has: (cap) => hasCapability(provider, cap)`, and the cast lives in one place
 * where it can be explained: `keyof PlatformProvider` includes `has` and `init`,
 * which are methods rather than capability slots, so the index has to be widened
 * to read them at all. They are always present, so they always answer true —
 * which is correct, if not very interesting.
 */
export function hasCapability(
  provider: PlatformProvider,
  capability: keyof PlatformProvider,
): boolean {
  return capability in provider
    && (provider as unknown as Record<string, unknown>)[capability] !== undefined;
}

/** Shared helper: case-insensitive substring match over app display names. */
export function matchAppsByName(apps: AppEntry[], query: string): AppEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return apps.filter((a) => a.name.toLowerCase().includes(q));
}

/**
 * The complete surface an adapter must (partly) provide. Optional members let a
 * platform advertise a subset; the agent checks `PlatformProvider.has(...)`.
 */
export interface PlatformProvider {
  readonly device: DeviceInfo;
  readonly system: SystemControl;
  readonly apps: AppControl;
  readonly navigation: Navigation;
  readonly network: NetworkInfo;
  readonly storage: KeyValueStore;
  readonly media?: MediaControl;
  readonly voice?: VoicePipeline;

  /** Runtime capability probe, e.g. has("voice") or has("media"). */
  has(capability: keyof PlatformProvider): boolean;
  /** Called once at startup so the adapter can wire native bridges. */
  init(): Promise<void>;
}
