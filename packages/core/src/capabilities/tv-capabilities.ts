import type { InputSource, RemoteKey } from "@tv-ai-agent/platform-api";
import { W } from "../world/state.js";
import type { Capability } from "./types.js";

/**
 * The host TV's capabilities — and, since `toolsFromCapabilities` projects them,
 * the single source of the tools the model is offered.
 *
 * Everything declarative lives here: the name the model calls, the sentence it
 * chooses on, the parameter schema, what must be true first, what changes, what
 * it risks, and how anyone would know it worked. `tv-tools.ts` supplies only the
 * platform calls. Adding a capability adds a tool; there is no second list to
 * keep in step.
 *
 * `provider` is filled in by the caller, because "who can do this" is the one
 * field that differs per device rather than per capability.
 */

const INPUT_SOURCES: InputSource[] = [
  "hdmi1", "hdmi2", "hdmi3", "hdmi4", "tv", "av", "component", "usb", "app",
];
const REMOTE_KEYS: RemoteKey[] = [
  "up", "down", "left", "right", "ok", "back", "home",
  "playpause", "stop", "rewind", "fastforward", "channelup", "channeldown", "menu",
];

export function createTvCapabilities(provider: string): Capability[] {
  const base = { device: "tv", provider, confidence: 1, status: "available" } as const;

  return [
    {
      ...base,
      id: "tv.audio.get_volume",
      name: "Read volume",
      // Both, in one call: "the volume is 0" and "the volume is 0 because the TV
      // is muted" are different answers, and a model that has to make two calls
      // to tell them apart usually makes one and guesses.
      description: "Get the current TV volume (0-100) and whether the TV is muted.",
      domain: "audio",
      parameters: {},
      tool: "get_volume",
      reads: { volume: W.tvVolume, muted: W.tvMuted },
      riskLevel: "low",
      verification: { kind: "none", because: "a read has nothing to verify" },
    },
    {
      ...base,
      id: "tv.audio.get_mute",
      name: "Read mute",
      description: "Check whether the TV audio is currently muted.",
      domain: "audio",
      parameters: {},
      tool: "get_mute",
      reads: { muted: W.tvMuted },
      riskLevel: "low",
      verification: { kind: "none", because: "a read has nothing to verify" },
    },
    {
      ...base,
      id: "tv.audio.set_volume",
      name: "Set volume",
      description: "Set the TV volume to an absolute level between 0 and 100.",
      domain: "audio",
      parameters: { level: { type: "number", description: "Volume 0-100", required: true } },
      tool: "set_volume",
      reads: { volume: W.tvVolume },
      constraints: [{ description: "0-100", parameter: "level", min: 0, max: 100 }],
      // Not `tv.power == on`: a TV in standby that accepts a volume change is
      // odd but harmless, and refusing to act on an *unknown* power state would
      // make the very first command of a session fail.
      preconditions: [{ path: W.tvPower, notEquals: "off", unknownOk: true }],
      sideEffects: [{ path: W.tvVolume, set: "{level}" }],
      riskLevel: "low",
      verification: {
        kind: "read_back",
        capability: "tv.audio.get_volume",
        predicate: { path: W.tvVolume, equals: "{level}" },
      },
    },
    {
      ...base,
      id: "tv.audio.set_mute",
      name: "Mute or unmute",
      description: "Mute or unmute the TV audio.",
      domain: "audio",
      parameters: { mute: { type: "boolean", description: "true to mute, false to unmute", required: true } },
      tool: "set_mute",
      reads: { muted: W.tvMuted },
      sideEffects: [{ path: W.tvMuted, set: "{mute}" }],
      riskLevel: "low",
      verification: {
        kind: "read_back",
        capability: "tv.audio.get_mute",
        predicate: { path: W.tvMuted, equals: "{mute}" },
      },
    },
    {
      ...base,
      id: "tv.input.get_source",
      name: "Read input source",
      description: "Get the currently active input source.",
      domain: "input",
      parameters: {},
      tool: "get_input_source",
      reads: { source: W.tvInput },
      riskLevel: "low",
      verification: { kind: "none", because: "a read has nothing to verify" },
    },
    {
      ...base,
      // Claimed, never proved: on Tizen the read works and the write is
      // signing-gated, so `available` would be a promise this build cannot keep.
      status: "unverified",
      id: "tv.input.switch",
      name: "Switch input",
      description: "Switch the active input source.",
      domain: "input",
      parameters: {
        source: { type: "string", description: "Input source id", required: true, enum: INPUT_SOURCES },
      },
      tool: "set_input_source",
      preconditions: [{ path: W.tvPower, notEquals: "off", unknownOk: true }],
      sideEffects: [{ path: W.tvInput, set: "{source}" }],
      // Not because switching is dangerous — it is trivially reversible — but
      // because it takes the screen away from whoever is watching. Disruption is
      // what `medium` means here, and it is what makes this ask first.
      riskLevel: "medium",
      verification: {
        kind: "read_back",
        capability: "tv.input.get_source",
        predicate: { path: W.tvInput, equals: "{source}" },
      },
    },
    {
      ...base,
      id: "tv.app.list",
      name: "List apps",
      description: "List installed applications available to launch.",
      domain: "app",
      parameters: {},
      tool: "list_apps",
      riskLevel: "low",
      verification: { kind: "none", because: "a read has nothing to verify" },
    },
    {
      ...base,
      id: "tv.app.search",
      name: "Find an app by name",
      description:
        "Find installed apps whose display name matches a query (case-insensitive). Use this to resolve a spoken app name into an app id before launching.",
      domain: "app",
      parameters: {
        query: { type: "string", description: "Part of the app's name, e.g. 'netflix'", required: true },
      },
      tool: "search_app_by_name",
      riskLevel: "low",
      verification: { kind: "none", because: "a read has nothing to verify" },
    },
    {
      ...base,
      id: "tv.app.launch",
      name: "Launch an app",
      description:
        "Launch an installed application by its id. Resolve the id with search_app_by_name first if unsure.",
      domain: "app",
      parameters: { appId: { type: "string", description: "Application id", required: true } },
      tool: "launch_app",
      sideEffects: [
        { path: W.tvForegroundApp, set: "{appId}" },
        { path: W.contentState, set: "unknown", confidence: 0.4 },
      ],
      // Interrupting what is on screen is the disruptive part, not the launch.
      riskLevel: "medium",
      verification: { kind: "none", because: "no HAL read for the foreground app on every target" },
    },
    {
      ...base,
      id: "tv.nav.press_key",
      name: "Press a remote key",
      description: "Inject a remote-control key to navigate the on-screen UI.",
      domain: "input",
      parameters: {
        key: { type: "string", description: "Remote key", required: true, enum: REMOTE_KEYS },
      },
      tool: "press_key",
      riskLevel: "low",
      verification: { kind: "none", because: "the effect of a key press is context-dependent" },
    },
  ];
}

/**
 * Powering an attached device — a console, a set-top box — over a transport the
 * TV can reach it on.
 *
 * Registered per device and per transport, so `ps5.power.on` can exist three
 * times (CEC, wake-on-LAN, an IR blaster) with different confidence. The
 * executor tries them in rank order and demotes whichever one fails, which is
 * the behaviour that makes a living room with mixed-vintage hardware workable at
 * all. `unverified` until something proves it: CEC in particular is advertised
 * far more often than it works.
 */
export function createDevicePowerCapabilities(deviceId: string, provider: string): Capability[] {
  const base = {
    device: deviceId,
    provider,
    confidence: provider === "cec" ? 0.7 : 0.5,
    status: "unverified",
    domain: "power",
    parameters: {},
  } as const;

  return [
    {
      ...base,
      id: `${deviceId}.power.on`,
      name: `Turn on ${deviceId}`,
      description: `Wake ${deviceId} over ${provider}.`,
      tool: `${provider}_power_on`,
      sideEffects: [{ path: W.device(deviceId, "power"), set: "on" }],
      riskLevel: "low",
      verification: {
        kind: "state",
        predicate: { path: W.device(deviceId, "power"), equals: "on" },
        timeoutMs: 8000,
      },
    },
    {
      ...base,
      id: `${deviceId}.power.off`,
      name: `Turn off ${deviceId}`,
      description: `Put ${deviceId} into standby over ${provider}.`,
      tool: `${provider}_power_off`,
      sideEffects: [{ path: W.device(deviceId, "power"), set: "standby" }],
      riskLevel: "medium",
      verification: {
        kind: "state",
        predicate: { path: W.device(deviceId, "power"), equals: "standby" },
        timeoutMs: 8000,
      },
    },
  ];
}

/**
 * Media transport, offered only where the platform advertises `media` — an
 * optional HAL member must not become a promise on a device without it.
 */
export function createMediaCapabilities(provider: string): Capability[] {
  const base = { device: "tv", provider, confidence: 1, status: "available", domain: "content" } as const;
  return [
    {
      ...base,
      id: "content.play",
      name: "Play a media URI",
      description: "Start playback of a media URI on the active player.",
      parameters: { uri: { type: "string", description: "Media URI", required: true } },
      tool: "media_play",
      sideEffects: [{ path: W.contentState, set: "playing" }],
      // Low, unlike `tv.app.launch`, because a URI only ever gets here because
      // someone asked for that thing by name — confirming "shall I play what you
      // just asked me to play?" is the kind of prompt that teaches people to
      // press OK without reading.
      riskLevel: "low",
      verification: { kind: "none", because: "no playback-state read in the HAL yet" },
    },
    {
      ...base,
      id: "content.pause",
      name: "Pause playback",
      description: "Pause the current playback.",
      parameters: {},
      tool: "media_pause",
      sideEffects: [{ path: W.contentState, set: "paused" }],
      riskLevel: "low",
      verification: { kind: "none", because: "no playback-state read in the HAL yet" },
    },
    {
      ...base,
      id: "content.resume",
      name: "Resume playback",
      description: "Resume paused playback.",
      parameters: {},
      tool: "media_resume",
      sideEffects: [{ path: W.contentState, set: "playing" }],
      riskLevel: "low",
      verification: { kind: "none", because: "no playback-state read in the HAL yet" },
    },
    {
      ...base,
      id: "content.seek",
      name: "Seek playback",
      description: "Seek the current playback to an absolute position in milliseconds.",
      parameters: { positionMs: { type: "number", description: "Position in ms", required: true } },
      tool: "media_seek",
      riskLevel: "low",
      verification: { kind: "none", because: "no playback-position read in the HAL yet" },
    },
  ];
}
