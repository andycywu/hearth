import type { PlatformProvider, InputSource, RemoteKey } from "@tv-ai-agent/platform-api";
import type { Tool } from "./registry.js";

/**
 * Factory that turns a PlatformProvider into a set of agent tools. This is the
 * single bridge between "what the LLM can ask for" and "what the platform can
 * do" — swap the provider (Tizen/AOSP/web) and the same tools keep working.
 *
 * Tools that depend on an optional capability (e.g. media) are only registered
 * when the provider advertises it via `has(...)`, so the LLM never sees a tool
 * the current device can't fulfil.
 */
const INPUT_SOURCES: InputSource[] = [
  "hdmi1", "hdmi2", "hdmi3", "hdmi4", "tv", "av", "component", "usb", "app",
];
const REMOTE_KEYS: RemoteKey[] = [
  "up", "down", "left", "right", "ok", "back", "home",
  "playpause", "stop", "rewind", "fastforward", "channelup", "channeldown", "menu",
];

export function createTvTools(platform: PlatformProvider): Tool[] {
  const tools: Tool[] = [
    {
      spec: {
        name: "get_volume",
        description: "Get the current TV volume (0-100).",
        parameters: {},
      },
      execute: async () => ({ volume: await platform.system.getVolume() }),
    },
    {
      spec: {
        name: "set_volume",
        description: "Set the TV volume to an absolute level between 0 and 100.",
        parameters: {
          level: { type: "number", description: "Volume 0-100", required: true },
        },
      },
      execute: async (args) => {
        await platform.system.setVolume(Number((args as any).level));
        return { ok: true, volume: await platform.system.getVolume() };
      },
    },
    {
      spec: {
        name: "set_mute",
        description: "Mute or unmute the TV audio.",
        parameters: {
          mute: { type: "boolean", description: "true to mute, false to unmute", required: true },
        },
      },
      execute: async (args) => {
        await platform.system.setMute(Boolean((args as any).mute));
        return { ok: true, muted: await platform.system.getMute() };
      },
    },
    {
      spec: {
        name: "get_input_source",
        description: "Get the currently active input source.",
        parameters: {},
      },
      execute: async () => ({ source: await platform.system.getInputSource() }),
    },
    {
      spec: {
        name: "set_input_source",
        description: "Switch the active input source.",
        parameters: {
          source: {
            type: "string",
            description: "Input source id",
            required: true,
            enum: INPUT_SOURCES,
          },
        },
      },
      execute: async (args) => {
        await platform.system.setInputSource((args as any).source as InputSource);
        return { ok: true };
      },
    },
    {
      spec: {
        name: "list_apps",
        description: "List installed applications available to launch.",
        parameters: {},
      },
      execute: async () => platform.apps.listInstalledApps(),
    },
    {
      spec: {
        name: "search_app_by_name",
        description:
          "Find installed apps whose display name matches a query (case-insensitive). Use this to resolve a spoken app name into an app id before launching.",
        parameters: {
          query: { type: "string", description: "Part of the app's name, e.g. 'netflix'", required: true },
        },
      },
      execute: async (args) => platform.apps.findAppsByName(String((args as any).query)),
    },
    {
      spec: {
        name: "launch_app",
        description:
          "Launch an installed application by its id. Resolve the id with search_app_by_name first if unsure.",
        parameters: {
          appId: { type: "string", description: "Application id", required: true },
        },
      },
      execute: async (args) => {
        await platform.apps.launchApp(String((args as any).appId));
        return { ok: true };
      },
    },
    {
      spec: {
        name: "press_key",
        description: "Inject a remote-control key to navigate the on-screen UI.",
        parameters: {
          key: {
            type: "string",
            description: "Remote key",
            required: true,
            enum: REMOTE_KEYS,
          },
        },
      },
      execute: async (args) => {
        await platform.navigation.sendKey((args as any).key as RemoteKey);
        return { ok: true };
      },
    },
  ];

  // --- media transport: only registered when the platform advertises it ---
  if (platform.has("media") && platform.media) {
    const media = platform.media;
    tools.push(
      {
        spec: {
          name: "media_play",
          description: "Start playback of a media URI on the active player.",
          parameters: { uri: { type: "string", description: "Media URI", required: true } },
        },
        execute: async (args) => { await media.play(String((args as any).uri)); return { ok: true }; },
      },
      {
        spec: { name: "media_pause", description: "Pause the current playback.", parameters: {} },
        execute: async () => { await media.pause(); return { ok: true }; },
      },
      {
        spec: { name: "media_resume", description: "Resume paused playback.", parameters: {} },
        execute: async () => { await media.resume(); return { ok: true }; },
      },
      {
        spec: {
          name: "media_seek",
          description: "Seek the current playback to an absolute position in milliseconds.",
          parameters: { positionMs: { type: "number", description: "Position in ms", required: true } },
        },
        execute: async (args) => { await media.seek(Number((args as any).positionMs)); return { ok: true }; },
      },
    );
  }

  return tools;
}
