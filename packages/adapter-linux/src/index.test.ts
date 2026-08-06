import { describe, it, expect } from "vitest";
import { assertProviderContract, isTvUnsupported } from "@tv-ai-agent/platform-api";
import { createLinuxAdapter } from "./index.js";
import {
  parseWpctlVolume, parsePactlVolume, parseAmixerVolume, parseAmixerMuted, detectAudioBackend,
} from "./audio.js";
import { parseDesktopEntry, execArgv, applicationDirs } from "./apps.js";
import type { Runner, RunResult } from "./run.js";
import { join } from "node:path";

/**
 * Real output from each tool, so the parsers are tested against what they will
 * actually be handed rather than what I imagined they'd be handed. This is the
 * whole reason commands go through an injected `Runner`: none of these programs
 * exist on the machine this suite runs on.
 */
const WPCTL_OUT = "Volume: 0.35\n";
const WPCTL_MUTED = "Volume: 0.35 [MUTED]\n";
const PACTL_OUT = "Volume: front-left: 22938 /  35% / -27.06 dB,   front-right: 22938 /  35% / -27.06 dB\n"
  + "        balance 0.00\n";
const AMIXER_OUT = [
  "Simple mixer control 'Master',0",
  "  Capabilities: pvolume pswitch pswitch-joined",
  "  Playback channels: Front Left - Front Right",
  "  Limits: Playback 0 - 65536",
  "  Front Left: Playback 22937 [35%] [-27.06dB] [on]",
  "  Front Right: Playback 22937 [35%] [-27.06dB] [on]",
].join("\n");

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const missing: RunResult = { code: 127, stdout: "", stderr: "command not found" };

/**
 * A `wpctl` that actually remembers what it was told.
 *
 * Needed because the shared contract round-trips volume and mute — set it, read
 * it back — which a canned-output fake can't satisfy. That makes this the better
 * fake regardless: it only answers if the adapter sends the exact arguments real
 * `wpctl` expects, so a typo in the sink name or the `%` suffix fails here.
 */
function fakeWpctl(): Runner & { state: { volume: number; muted: boolean } } {
  const state = { volume: 0.35, muted: false };
  const run = (async (cmd: string, args: string[]) => {
    if (cmd !== "wpctl") return missing;
    const [verb, sink, value] = args;
    if (sink !== "@DEFAULT_AUDIO_SINK@") return { code: 1, stdout: "", stderr: `no such sink ${sink}` };
    switch (verb) {
      case "get-volume":
        return ok(`Volume: ${state.volume.toFixed(2)}${state.muted ? " [MUTED]" : ""}\n`);
      case "set-volume": {
        const pct = /^(\d{1,3})%$/.exec(value ?? "");
        if (!pct) return { code: 1, stdout: "", stderr: `bad volume ${value}` };
        state.volume = Number(pct[1]) / 100;
        return ok("");
      }
      case "set-mute":
        if (value !== "0" && value !== "1") return { code: 1, stdout: "", stderr: `bad mute ${value}` };
        state.muted = value === "1";
        return ok("");
      default:
        return { code: 1, stdout: "", stderr: `unknown verb ${verb}` };
    }
  }) as Runner & { state: typeof state };
  run.state = state;
  return run;
}

/** A runner that answers only for `only`, and reports everything else absent. */
function runnerFor(only: string, out: string): Runner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    return cmd === only ? ok(out) : missing;
  }) as Runner & { calls: string[] };
  run.calls = calls;
  return run;
}

describe("volume parsing — against real output", () => {
  it("wpctl", () => {
    expect(parseWpctlVolume(WPCTL_OUT)).toBe(35);
    expect(parseWpctlVolume(WPCTL_MUTED)).toBe(35);
    expect(parseWpctlVolume("nonsense")).toBeUndefined();
  });

  it("wpctl reports a fraction, not a percentage", () => {
    // The one that would silently produce 1% instead of 100%.
    expect(parseWpctlVolume("Volume: 1.00")).toBe(100);
    expect(parseWpctlVolume("Volume: 0.00")).toBe(0);
  });

  it("pactl, taking the first channel", () => {
    expect(parsePactlVolume(PACTL_OUT)).toBe(35);
    expect(parsePactlVolume("Volume: front-left: 0 / 0% / -inf dB")).toBe(0);
  });

  it("amixer, from the bracketed percentage", () => {
    expect(parseAmixerVolume(AMIXER_OUT)).toBe(35);
    expect(parseAmixerMuted(AMIXER_OUT)).toBe(false);
    expect(parseAmixerMuted(AMIXER_OUT.replace(/\[on\]/g, "[off]"))).toBe(true);
  });
});

describe("audio backend detection", () => {
  it("prefers PipeWire when it answers", async () => {
    const run = runnerFor("wpctl", WPCTL_OUT);
    expect((await detectAudioBackend(run))?.name).toBe("wireplumber");
  });

  it("falls to PulseAudio, then ALSA", async () => {
    expect((await detectAudioBackend(runnerFor("pactl", PACTL_OUT)))?.name).toBe("pulseaudio");
    expect((await detectAudioBackend(runnerFor("amixer", AMIXER_OUT)))?.name).toBe("alsa");
  });

  it("answers undefined on a box with none of them", async () => {
    expect(await detectAudioBackend(async () => missing)).toBeUndefined();
  });

  it("rejects a tool that exists but can't answer", async () => {
    // `wpctl` installed with no PipeWire session exits non-zero. Looking for the
    // binary on PATH would have picked it and then failed on every call.
    const run: Runner = async (cmd) =>
      cmd === "wpctl" ? { code: 1, stdout: "", stderr: "no session" } : ok(PACTL_OUT);
    expect((await detectAudioBackend(run))?.name).toBe("pulseaudio");
  });
});

describe("desktop entries", () => {
  it("reads the name and command", () => {
    const entry = parseDesktopEntry("netflix", "[Desktop Entry]\nType=Application\nName=Netflix\nExec=netflix %U\n");
    expect(entry).toMatchObject({ id: "netflix", name: "Netflix" });
  });

  it("skips what a launcher would skip", () => {
    const cases = [
      "[Desktop Entry]\nType=Application\nName=X\nExec=x\nNoDisplay=true\n",
      "[Desktop Entry]\nType=Application\nName=X\nExec=x\nHidden=true\n",
      "[Desktop Entry]\nType=Link\nName=X\nURL=http://x\n",
      "[Desktop Entry]\nType=Application\nName=X\n",          // no Exec
      "Name=X\nExec=x\n",                                      // no group header
    ];
    for (const text of cases) expect(parseDesktopEntry("x", text), text.slice(0, 40)).toBeUndefined();
  });

  it("prefers the plain Name over a localised one", () => {
    const text = "[Desktop Entry]\nType=Application\nName[de]=Rechner\nName=Calculator\nExec=calc\n";
    expect(parseDesktopEntry("calc", text)?.name).toBe("Calculator");
  });

  it("doesn't let GenericName masquerade as Name", () => {
    const text = "[Desktop Entry]\nType=Application\nGenericName=Browser\nName=Firefox\nExec=firefox\n";
    expect(parseDesktopEntry("ff", text)?.name).toBe("Firefox");
  });

  it("strips the field codes, which apps choke on", () => {
    // %U and friends are placeholders a launcher substitutes; we open no file.
    expect(execArgv("netflix %U")).toEqual(["netflix"]);
    expect(execArgv("/usr/bin/vlc --started-from-file %F")).toEqual(["/usr/bin/vlc", "--started-from-file"]);
    expect(execArgv("app")).toEqual(["app"]);
  });

  it("looks in the XDG directories, the user's own first", () => {
    // Compared through `join` because this suite also runs on Windows, where the
    // separator differs. The adapter itself only ever runs on Linux.
    const dirs = applicationDirs({ XDG_DATA_HOME: "/home/me/.local/share", XDG_DATA_DIRS: "/usr/share" });
    expect(dirs[0]).toBe(join("/home/me/.local/share", "applications"));
    expect(dirs).toContain(join("/usr/share", "applications"));
  });
});

describe("createLinuxAdapter", () => {
  const withAudio = () =>
    createLinuxAdapter({ run: fakeWpctl(), apps: [], storePath: memStorePath() });

  it("satisfies the shared provider contract", async () => {
    // The same contract the four TV adapters are held to. A fifth platform that
    // needed the harness changed would mean the abstraction had failed.
    const platform = withAudio();
    await platform.init();
    await assertProviderContract(() => platform, { allowWrites: false });
  });

  it("reports the backend it found", async () => {
    const platform = withAudio();
    await platform.init();
    expect(platform.device.model).toContain("wireplumber");
    expect(platform.device.capabilities.audio).toBe(true);
    expect(await platform.system.getVolume()).toBe(35);
  });

  it("says audio is unsupported, not broken, on a box with no mixer", async () => {
    const platform = createLinuxAdapter({ run: async () => missing, apps: [], storePath: memStorePath() });
    await platform.init();
    expect(platform.device.capabilities.audio).toBe(false);
    await expect(platform.system.getVolume()).rejects.toSatisfy(isTvUnsupported);
  });

  it("reports the things a Linux box genuinely can't do as unsupported", async () => {
    // Not failures to retry: there is no tuner to switch to, and key injection
    // needs a display server this adapter deliberately doesn't assume.
    const platform = withAudio();
    await platform.init();
    await expect(platform.system.setInputSource("hdmi1")).rejects.toSatisfy(isTvUnsupported);
    await expect(platform.navigation.sendKey("up")).rejects.toSatisfy(isTvUnsupported);
    await expect(platform.system.powerStandby()).rejects.toSatisfy(isTvUnsupported);
    expect(await platform.navigation.isAvailable?.()).toBe(false);
  });

  it("round-trips volume and mute through the real command shapes", async () => {
    // The fake only answers to the arguments wpctl actually takes, so this also
    // pins the sink name and the `%` suffix.
    const run = fakeWpctl();
    const platform = createLinuxAdapter({ run, apps: [], storePath: memStorePath() });
    await platform.init();
    await platform.system.setVolume(72);
    expect(await platform.system.getVolume()).toBe(72);
    await platform.system.setMute(true);
    expect(await platform.system.getMute()).toBe(true);
    // Clamped before it reaches the command, not rejected by it.
    await platform.system.setVolume(500);
    expect(run.state.volume).toBe(1);
  });

  it("finds an app by name and refuses one it doesn't have", async () => {
    const platform = createLinuxAdapter({
      run: fakeWpctl(),
      apps: [{ id: "netflix", name: "Netflix", exec: "true" }],
      storePath: memStorePath(),
    });
    await platform.init();
    expect(await platform.apps.findAppsByName("netfl")).toEqual([{ id: "netflix", name: "Netflix" }]);
    await expect(platform.apps.launchApp("nope")).rejects.toThrow(/no application named nope/);
  });
});

/** A throwaway store path per test, so they don't share state. */
let n = 0;
function memStorePath(): string {
  return `${globalThis.process?.env?.TEMP ?? "/tmp"}/tv-agent-test-${process.pid}-${n++}.json`;
}
