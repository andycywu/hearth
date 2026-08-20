import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import {
  matchAppsByName, hasCapability, TvUnsupportedError,
  type PlatformProvider, type DeviceInfo, type InputSource,
} from "@hearthkit/platform-api";
import { systemRunner, type Runner } from "./run.js";
import { detectAudioBackend, noAudio, type AudioBackend } from "./audio.js";
import { execArgv, listDesktopEntries, type DesktopEntry } from "./apps.js";
import { createFileStore } from "./storage.js";

/**
 * A Linux device that *is* the TV — a set-top box, a Pi, an embedded panel —
 * driven from a shell on the device itself rather than from a WebView on it.
 *
 * This is the adapter that proves the layering claim, because nothing above it
 * changed to accommodate it: the agent loop, the tools and their names, the
 * result envelope and the confirmation gate are the ones the television builds
 * use. Only this file knows that volume means `wpctl` here.
 *
 * What it deliberately does not do: no `xdotool`/`ydotool` key injection and no
 * input switching. A generic Linux box has no tuner, and key injection needs a
 * display server plus permissions that vary per image. Both report
 * `TvUnsupportedError`, which reaches the user as "this TV can't do that"
 * instead of a retryable-looking failure.
 */
export interface LinuxAdapterOptions {
  /** Run a command. Substituted in tests; defaults to spawning it. */
  run?: Runner;
  /** Where the key-value store lives. Defaults under `$XDG_CONFIG_HOME`. */
  storePath?: string;
  /** Skip the `.desktop` scan (tests, or a box with no launcher). */
  apps?: DesktopEntry[];
}

export function createLinuxAdapter(opts: LinuxAdapterOptions = {}): PlatformProvider {
  const run = opts.run ?? systemRunner();
  let audio: AudioBackend | undefined;
  let apps: DesktopEntry[] = opts.apps ?? [];

  const device: DeviceInfo = {
    os: "linux",
    osVersion: process.version,
    soc: "unknown",
    model: "Linux",
    // Filled in by init(), which is the only place that can find out.
    capabilities: { media: false, voice: false, audio: false, apps: false },
  };

  const provider: PlatformProvider = {
    device,
    system: {
      getVolume: async () => (audio ? audio.getVolume(run) : noAudio()),
      setVolume: async (level) => (audio ? audio.setVolume(run, level) : noAudio()),
      getMute: async () => (audio ? audio.getMute(run) : noAudio()),
      setMute: async (mute) => (audio ? audio.setMute(run, mute) : noAudio()),
      // No tuner and no HDMI switch on a box like this. Reporting "app" is
      // honest — that is what is on screen — and switching is not a thing here.
      getInputSource: async () => "app" as InputSource,
      setInputSource: async () => {
        throw new TvUnsupportedError("switching input — this device has no TV inputs to switch between");
      },
      powerStandby: async () => {
        // `systemctl suspend` would need policy this process may not have, and
        // suspending the box the agent runs on is a decision for its owner.
        throw new TvUnsupportedError("standby — suspend this device with its own power management");
      },
    },
    apps: {
      listInstalledApps: async () => apps.map(({ id, name }) => ({ id, name })),
      launchApp: async (appId) => {
        const entry = apps.find((a) => a.id === appId);
        if (!entry) throw new Error(`no application named ${appId}; try search_app_by_name first`);
        const [cmd, ...args] = execArgv(entry.exec);
        if (!cmd) throw new Error(`${appId} has no runnable Exec line`);
        // Detached and unparented: the agent may be a short-lived CLI process,
        // and the app it launched should outlive it rather than die with it.
        spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
      },
      // Which window has focus needs a display-server query that differs per
      // compositor; claiming to know would be worse than saying nothing.
      getForegroundApp: async () => null,
      findAppsByName: async (q) => matchAppsByName(apps.map(({ id, name }) => ({ id, name })), q),
    },
    navigation: {
      sendKey: async () => {
        throw new TvUnsupportedError(
          "key injection — needs xdotool (X11) or ydotool (Wayland, plus uinput access)",
        );
      },
      isAvailable: async () => false,
    },
    network: {
      // From the kernel's own view rather than by pinging something: an agent
      // must not need a route to the internet to answer "am I connected".
      isOnline: async () => activeInterfaces().length > 0,
      connectionType: async () => {
        const names = activeInterfaces();
        if (names.some((n) => /^(wl|wlan)/.test(n))) return "wifi";
        if (names.length) return "ethernet";
        return "none";
      },
    },
    storage: createFileStore(opts.storePath),
    has: (cap) => hasCapability(provider, cap),
    init: async () => {
      audio = await detectAudioBackend(run);
      if (!opts.apps) apps = await listDesktopEntries();
      device.capabilities.audio = audio !== undefined;
      device.capabilities.apps = apps.length > 0;
      device.model = audio ? `Linux (${audio.name})` : "Linux";
    },
  };
  return provider;
}

/** Interface names that are up and not loopback. */
function activeInterfaces(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([, addrs]) => addrs?.some((a) => !a.internal))
    .map(([name]) => name);
}

export { systemRunner, type Runner, type RunResult } from "./run.js";
export {
  parseWpctlVolume, parsePactlVolume, parseAmixerVolume, parseAmixerMuted, detectAudioBackend,
} from "./audio.js";
export { parseDesktopEntry, execArgv, applicationDirs, listDesktopEntries } from "./apps.js";
