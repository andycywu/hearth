import type { PlatformProvider, InputSource, RemoteKey } from "@hearthkit/platform-api";
import type { Capability } from "../capabilities/types.js";
import {
  createTvCapabilities, createMediaCapabilities,
} from "../capabilities/tv-capabilities.js";
import { toolsFromCapabilities, type CapabilityHandler } from "../capabilities/to-tools.js";
import type { Tool } from "./registry.js";

/**
 * The bridge between "what the agent can do" and "what this platform can do".
 *
 * Everything declarative — the tool name, the sentence the model chooses on, the
 * parameter schema, whether it needs confirming — now comes from the capability
 * catalogue, and this file supplies only the part that cannot be data: the call
 * into the HAL. Swap the provider (Tizen/AOSP/webOS/web) and the same
 * capabilities keep working, which was always the claim; the difference is that
 * there is no longer a second, hand-written list of tools that could disagree
 * with the first.
 */

/** Which capabilities this device can offer, before any probing narrows it. */
export function capabilitiesForPlatform(platform: PlatformProvider): Capability[] {
  const provider = `adapter:${platform.device.os}`;
  return [
    ...createTvCapabilities(provider),
    // Optional HAL member: a device without it must never be offered the tools.
    ...(platform.has("media") && platform.media ? createMediaCapabilities(provider) : []),
  ];
}

export function createTvTools(platform: PlatformProvider): Tool[] {
  return toolsFromCapabilities(capabilitiesForPlatform(platform), tvHandlers(platform));
}

/**
 * Capability id -> the platform call that performs it.
 *
 * A handler returns what the TV said and nothing else: no error taxonomy, no
 * result envelope. Both are applied once, in the projection.
 */
export function tvHandlers(platform: PlatformProvider): Record<string, CapabilityHandler> {
  const handlers: Record<string, CapabilityHandler> = {
    "tv.audio.get_volume": async () => ({
      volume: await platform.system.getVolume(),
      muted: await platform.system.getMute(),
    }),
    // There was a `set_mute` with nothing to read it back, so "is the TV muted?"
    // was a question the agent could not answer — and after muting, `get_volume`
    // reports 0 on Android (the platform zeroes the stream while muted), which
    // hides the difference between muted and turned down.
    "tv.audio.get_mute": async () => ({ muted: await platform.system.getMute() }),
    "tv.audio.set_volume": async (args) => {
      await platform.system.setVolume(Number(args.level));
      return { volume: await platform.system.getVolume() };
    },
    "tv.audio.set_mute": async (args) => {
      await platform.system.setMute(Boolean(args.mute));
      return { muted: await platform.system.getMute() };
    },
    "tv.input.get_source": async () => ({ source: await platform.system.getInputSource() }),
    "tv.input.switch": async (args) => {
      await platform.system.setInputSource(args.source as InputSource);
      return undefined;
    },
    "tv.app.list": async () => platform.apps.listInstalledApps(),
    "tv.app.search": async (args) => platform.apps.findAppsByName(String(args.query)),
    "tv.app.launch": async (args) => {
      await platform.apps.launchApp(String(args.appId));
      return undefined;
    },
    "tv.nav.press_key": async (args) => {
      await platform.navigation.sendKey(args.key as RemoteKey);
      return undefined;
    },
  };

  const media = platform.media;
  if (platform.has("media") && media) {
    handlers["content.play"] = async (args) => { await media.play(String(args.uri)); };
    handlers["content.pause"] = async () => { await media.pause(); };
    handlers["content.resume"] = async () => { await media.resume(); };
    handlers["content.seek"] = async (args) => { await media.seek(Number(args.positionMs)); };
  }

  return handlers;
}
