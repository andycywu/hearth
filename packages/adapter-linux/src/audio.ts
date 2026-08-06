import { TvUnsupportedError } from "@tv-ai-agent/platform-api";
import type { Runner } from "./run.js";

/**
 * Volume and mute on Linux, where there is no one answer.
 *
 * A TV-ish Linux box is running PipeWire, PulseAudio or bare ALSA depending on
 * how old the image is, and the three speak different commands with different
 * output. So the backend is chosen once, at init, by asking which tool is
 * actually installed — that is a probe, not a fallback chain: after init there
 * is exactly one backend and no retry logic anywhere.
 *
 * The parsers are the interesting part, and they are pure so they can be tested
 * against real command output without a sound card.
 */

export interface AudioBackend {
  readonly name: "wireplumber" | "pulseaudio" | "alsa";
  getVolume(run: Runner): Promise<number>;
  setVolume(run: Runner, level: number): Promise<void>;
  getMute(run: Runner): Promise<boolean>;
  setMute(run: Runner, mute: boolean): Promise<void>;
}

/** `Volume: 0.35` / `Volume: 0.35 [MUTED]` → 35 */
export function parseWpctlVolume(out: string): number | undefined {
  const m = /Volume:\s*([0-9]*\.?[0-9]+)/.exec(out);
  return m ? Math.round(Number(m[1]) * 100) : undefined;
}

/** `Volume: front-left: 22938 /  35% / -27.06 dB, front-right: …` → 35 */
export function parsePactlVolume(out: string): number | undefined {
  // First percentage wins: channels are reported separately and the agent
  // speaks in one number. They are kept in step by set-sink-volume anyway.
  const m = /(\d{1,3})%/.exec(out);
  return m ? Number(m[1]) : undefined;
}

/** `  Front Left: Playback 65536 [100%] [0.00dB] [on]` → 100 */
export function parseAmixerVolume(out: string): number | undefined {
  const m = /\[(\d{1,3})%\]/.exec(out);
  return m ? Number(m[1]) : undefined;
}

/** amixer marks mute per channel as `[off]`. */
export function parseAmixerMuted(out: string): boolean {
  return /\[off\]/.test(out);
}

const SINK = "@DEFAULT_AUDIO_SINK@";
const PA_SINK = "@DEFAULT_SINK@";

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** Fail loudly rather than report a wrong number the agent would then read back. */
async function need(run: Runner, cmd: string, args: string[]): Promise<string> {
  const r = await run(cmd, args);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

function unparsable(cmd: string, out: string): never {
  throw new Error(`could not read the volume from ${cmd}: ${JSON.stringify(out.slice(0, 80))}`);
}

export const WIREPLUMBER: AudioBackend = {
  name: "wireplumber",
  getVolume: async (run) => {
    const out = await need(run, "wpctl", ["get-volume", SINK]);
    return parseWpctlVolume(out) ?? unparsable("wpctl", out);
  },
  setVolume: async (run, level) => { await need(run, "wpctl", ["set-volume", SINK, `${clamp(level)}%`]); },
  getMute: async (run) => /\[MUTED\]/.test(await need(run, "wpctl", ["get-volume", SINK])),
  setMute: async (run, mute) => { await need(run, "wpctl", ["set-mute", SINK, mute ? "1" : "0"]); },
};

export const PULSEAUDIO: AudioBackend = {
  name: "pulseaudio",
  getVolume: async (run) => {
    const out = await need(run, "pactl", ["get-sink-volume", PA_SINK]);
    return parsePactlVolume(out) ?? unparsable("pactl", out);
  },
  setVolume: async (run, level) => { await need(run, "pactl", ["set-sink-volume", PA_SINK, `${clamp(level)}%`]); },
  getMute: async (run) => /Mute:\s*yes/i.test(await need(run, "pactl", ["get-sink-mute", PA_SINK])),
  setMute: async (run, mute) => { await need(run, "pactl", ["set-sink-mute", PA_SINK, mute ? "1" : "0"]); },
};

export const ALSA: AudioBackend = {
  name: "alsa",
  getVolume: async (run) => {
    const out = await need(run, "amixer", ["get", "Master"]);
    return parseAmixerVolume(out) ?? unparsable("amixer", out);
  },
  setVolume: async (run, level) => { await need(run, "amixer", ["set", "Master", `${clamp(level)}%`]); },
  getMute: async (run) => parseAmixerMuted(await need(run, "amixer", ["get", "Master"])),
  setMute: async (run, mute) => { await need(run, "amixer", ["set", "Master", mute ? "mute" : "unmute"]); },
};

/**
 * Which backend this machine has, in order of what a current image is likeliest
 * to be running. Asking the tool to do something harmless is a better test than
 * looking for the binary: a `wpctl` on a box with no PipeWire session exits
 * non-zero, and finding it on PATH would have told us the wrong thing.
 */
export async function detectAudioBackend(run: Runner): Promise<AudioBackend | undefined> {
  for (const backend of [WIREPLUMBER, PULSEAUDIO, ALSA]) {
    try {
      await backend.getVolume(run);
      return backend;
    } catch {
      // Not this one. Keep looking; `undefined` at the end is a real answer.
    }
  }
  return undefined;
}

/** The audio surface when nothing on this box can do it. */
export function noAudio(): never {
  throw new TvUnsupportedError(
    "audio control — no wpctl (PipeWire), pactl (PulseAudio) or amixer (ALSA) on this system",
  );
}
