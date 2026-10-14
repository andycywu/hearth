/**
 * The audio half of the lab: is the microphone hearing anything, and does the
 * speaker say anything — each answered with a number or a sound a person can
 * check, not a green tick.
 *
 * The 2026-10-14 walk-through recorded two "speak now" clips whose peak level was
 * identical to the empty room's; whether nobody spoke or the microphone was
 * deaf could not be told from the log. Here a recording comes back with its
 * level in dB next to the room's, and can be played back through the speaker.
 */
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemRunner, type Runner } from "./run.js";
import { espeakArgs, validateTtsChoice } from "./tts-voices.js";

export interface WavLevels {
  seconds: number;
  /** Full scale = 0 dB. Silence is -Infinity; the JSON carries `null`. */
  rmsDb: number | null;
  peakDb: number | null;
  /** The same two as fractions of full scale. */
  rms: number;
  peak: number;
}

const db = (x: number): number | null => (x > 0 ? Number((20 * Math.log10(x)).toFixed(1)) : null);

/** RMS and peak of a 16-bit PCM WAV. Throws on anything else, saying what it was. */
export function levelsOfWav(bytes: Uint8Array): WavLevels {
  if (bytes.length < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") throw new Error("not a WAV file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  let bits = 0;
  let rate = 16_000;
  let channels = 1;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") { channels = view.getUint16(body + 2, true); rate = view.getUint32(body + 4, true); bits = view.getUint16(body + 14, true); }
    if (id === "data") {
      if (bits !== 16) throw new Error(`WAV is ${bits}-bit, not 16-bit PCM`);
      const end = Math.min(bytes.length, body + size);
      const n = Math.floor((end - body) / 2);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const s = Math.abs(view.getInt16(body + i * 2, true)) / 32768;
        sum += s * s;
        if (s > peak) peak = s;
      }
      const rms = n ? Math.sqrt(sum / n) : 0;
      return { seconds: Number((n / channels / rate).toFixed(2)), rms, peak, rmsDb: db(rms), peakDb: db(peak) };
    }
    at = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export interface AudioLab {
  /** Record for `seconds` from the capture device and measure it. The bytes are kept for `last()`. */
  record(seconds: number): Promise<{ ok: boolean; levels?: WavLevels; error?: string; cmdline: string }>;
  /** The last recording, for playback in the page or through the speaker. */
  last(): Uint8Array | undefined;
  play(): Promise<{ ok: boolean; error?: string; cmdline: string }>;
  /** `choice` is a `TtsChoice` from outside (a web page); it is validated before it reaches a command line. */
  say(text: string, choice?: unknown): Promise<{ ok: boolean; error?: string; cmdline: string }>;
}

export function createAudioLab(o: { device?: string; run?: Runner; readCapture?: (p: string) => Promise<Uint8Array>; path?: string } = {}): AudioLab {
  const run = o.run ?? systemRunner(30_000);
  const device = o.device ?? "default";
  const path = o.path ?? join(tmpdir(), "hearth-lab-capture.wav");
  const read = o.readCapture ?? (async (p) => new Uint8Array(await readFile(p)));
  let kept: Uint8Array | undefined;

  const fail = (r: { code: number; stderr: string }, what: string): string => `${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`;

  return {
    last: () => kept,

    async record(seconds) {
      const s = Math.max(1, Math.min(15, Math.round(seconds)));
      const args = ["-D", device, "-f", "S16_LE", "-r", "16000", "-c", "1", "-d", String(s), "-q", path];
      const cmdline = ["arecord", ...args].join(" ");
      const r = await run("arecord", args);
      if (r.code !== 0) return { ok: false, error: fail(r, "arecord"), cmdline };
      try {
        kept = await read(path);
        await rm(path, { force: true }).catch(() => {});
        return { ok: true, levels: levelsOfWav(kept), cmdline };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), cmdline };
      }
    },

    async play() {
      if (!kept) return { ok: false, error: "nothing recorded yet", cmdline: "aplay" };
      const { writeFile } = await import("node:fs/promises");
      const playPath = path.replace(/\.wav$/, "-play.wav");
      await writeFile(playPath, kept);
      const r = await run("aplay", ["-q", playPath]);
      await rm(playPath, { force: true }).catch(() => {});
      return r.code === 0 ? { ok: true, cmdline: `aplay -q ${playPath}` } : { ok: false, error: fail(r, "aplay"), cmdline: `aplay -q ${playPath}` };
    },

    async say(text, choice) {
      const t = text.trim().slice(0, 200);
      if (!t) return { ok: false, error: "nothing to say", cmdline: "espeak-ng" };
      // Checked here, not only where it came from: this is the last stop before a command line.
      const checked = validateTtsChoice(choice ?? {});
      if (!checked.ok) return { ok: false, error: checked.error, cmdline: "espeak-ng" };
      const args = espeakArgs(checked.choice, t);
      const r = await run("espeak-ng", args);
      const cmdline = ["espeak-ng", ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");
      return r.code === 0 ? { ok: true, cmdline } : { ok: false, error: fail(r, "espeak-ng"), cmdline };
    },
  };
}
