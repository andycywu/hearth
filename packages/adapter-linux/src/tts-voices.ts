/**
 * The voices the box can speak with, and how a choice of one becomes an `espeak-ng` command line.
 *
 * espeak-ng ships with well over a hundred languages and accents, and each takes a *variant* — a male or
 * female timbre, a croak, a whisper — so "many voices" is a few thousand combinations, all of them
 * recognisably a machine. That is what a Pi has with nothing else installed; a neural voice is a
 * separate piece of work (see docs/avatar-and-voice.md), and this is the interface it would sit behind:
 * a `TtsChoice` is a voice name plus two numbers, and everything that speaks takes one.
 */
import type { Runner } from "./run.js";

export interface TtsVoice {
  /** What goes after `-v`: `en-us`, `cmn`, `de`. */
  id: string;
  /** `Chinese (Mandarin, latin as English)` — espeak-ng's own name for it, underscores undone. */
  name: string;
  gender: "male" | "female" | "neutral";
  /** espeak-ng's voice file, e.g. `sit/cmn`; useful in a bug report, nothing else. */
  file: string;
}

export interface TtsVariant {
  /** Appended to the voice with `+`: `m3` gives `en-us+m3`. Empty is the voice as it comes. */
  id: string;
  label: string;
}

/** espeak-ng's own variants: seven male and five female timbres, and three effects. */
export const TTS_VARIANTS: readonly TtsVariant[] = [
  { id: "", label: "as it comes" },
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `m${n}`, label: `male ${n}` })),
  ...[1, 2, 3, 4, 5].map((n) => ({ id: `f${n}`, label: `female ${n}` })),
  { id: "croak", label: "croaky" },
  { id: "whisper", label: "whisper" },
  { id: "klatt", label: "Klatt synthesiser" },
];

/**
 * `espeak-ng --voices` → the voices.
 *
 * ```
 * Pty Language       Age/Gender VoiceName          File                 Other Languages
 *  5  af              --/M      Afrikaans          gmw/af
 *  5  cmn             --/M      Chinese_(Mandarin,_latin_as_English) sit/cmn   (zh-cmn 5)(zh 5)
 * ```
 */
export function parseEspeakVoices(out: string): TtsVoice[] {
  const voices: TtsVoice[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*\d+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line);
    if (!m || m[1] === "Language") continue;
    const [, id, ageGender, name, file] = m as unknown as [string, string, string, string, string];
    voices.push({
      id, file, name: name.replace(/_/g, " "),
      gender: ageGender.endsWith("/M") ? "male" : ageGender.endsWith("/F") ? "female" : "neutral",
    });
  }
  return voices;
}

export async function listTtsVoices(run: Runner): Promise<TtsVoice[]> {
  const r = await run("espeak-ng", ["--voices"]);
  if (r.code !== 0) throw new Error(`espeak-ng --voices failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return parseEspeakVoices(r.stdout);
}

/** What a person picks: a voice, how fast, and how high. Everything optional — espeak-ng has defaults. */
export interface TtsChoice {
  /** `en-us` or `en-us+f3`. */
  voice?: string | undefined;
  /** Words per minute, 80–450. espeak-ng's default is 175. */
  speed?: number | undefined;
  /** 0–99. espeak-ng's default is 50. */
  pitch?: number | undefined;
}

const VOICE = /^[a-z][a-z0-9-]{0,23}(\+[a-z0-9]{1,10})?$/i;

/** A choice from outside — a web page, a config file — checked before it can reach a command line. */
export function validateTtsChoice(input: unknown): { ok: true; choice: TtsChoice } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "not an object" };
  const o = input as Record<string, unknown>;
  const choice: TtsChoice = {};
  if (o.voice !== undefined && o.voice !== "") {
    if (typeof o.voice !== "string" || !VOICE.test(o.voice)) return { ok: false, error: `"${String(o.voice)}" is not a voice name` };
    choice.voice = o.voice;
  }
  if (o.speed !== undefined) {
    const n = Number(o.speed);
    if (!Number.isFinite(n) || n < 80 || n > 450) return { ok: false, error: "speed must be 80–450 words per minute" };
    choice.speed = Math.round(n);
  }
  if (o.pitch !== undefined) {
    const n = Number(o.pitch);
    if (!Number.isFinite(n) || n < 0 || n > 99) return { ok: false, error: "pitch must be 0–99" };
    choice.pitch = Math.round(n);
  }
  return { ok: true, choice };
}

/**
 * The argument list for speaking `text`. The text goes after `--` so that "--stdout" said aloud is a
 * sentence and not a flag, and the voice name was validated above, so neither can become a different
 * command.
 */
export function espeakArgs(choice: TtsChoice, text: string): string[] {
  return [
    ...(choice.voice ? ["-v", choice.voice] : []),
    ...(choice.speed !== undefined ? ["-s", String(choice.speed)] : []),
    ...(choice.pitch !== undefined ? ["-p", String(choice.pitch)] : []),
    "--", text,
  ];
}
