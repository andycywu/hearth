/**
 * Where the wake-word detector comes from, and whether this box has it.
 *
 *   HEARTH_WAKE_DETECTOR   kws | transcript (default). `kws` runs a local keyword spotter before any recognition; `transcript`
 *                          looks for the word in what a recogniser returned — which means everything with sound in it is
 *                          recognised first, and, with a hosted recogniser, paid for.
 *   HEARTH_KWS_MODEL_PATH  a keyword-spotting model directory (required)
 *   HEARTH_KWS_PYTHON      the Python with `sherpa-onnx` and `numpy` (default: python3)
 *   HEARTH_KWS_SCRIPT      tools/kws/hearth_kws.py (default: the one in this checkout)
 *   HEARTH_KWS_THRESHOLD   lower fires more easily (default: the model's, 0.25 — the measured one)
 *   HEARTH_KWS_SCORE       keyword boost (default 1.0)
 *   HEARTH_KWS_CHUNK       16 (default) or 8
 *   HEARTH_KWS_PREROLL_MS  audio replayed when it fires (default 800)
 *
 * Nothing here starts a process; it only says what would be started and, if it cannot be, why — in words that name the
 * variable to set, since the alternative is a box that boots, listens to nothing, and says nothing.
 */
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { wakeWordList } from "./wake.js";

export interface KwsSettings {
  python: string;
  script: string;
  modelDir: string;
  keywords: string[];
  threshold?: number;
  score?: number;
  chunk?: number;
  preRollMs?: number;
}

export type KwsResolution = { ok: true; settings: KwsSettings } | { ok: false; why: string };

/** The variables a boot service needs to find the same detector (paths only; there are no secrets here). */
export const KWS_ENV_KEYS = [
  "HEARTH_KWS_MODEL_PATH", "HEARTH_KWS_PYTHON", "HEARTH_KWS_SCRIPT", "HEARTH_KWS_THRESHOLD", "HEARTH_KWS_SCORE", "HEARTH_KWS_CHUNK",
  "HEARTH_KWS_PREROLL_MS",
] as const;

export function kwsEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KWS_ENV_KEYS) if (env[k]?.trim()) out[k] = env[k]!.trim();
  return out;
}

/** What `config.json` remembers of the detector: the model and how it is run. Paths and numbers, no secrets. */
export interface KwsConfig {
  modelPath?: string;
  python?: string;
  script?: string;
  threshold?: number;
  score?: number;
  chunk?: number;
  preRollMs?: number;
}

const FIELDS: ReadonlyArray<[keyof KwsConfig, (typeof KWS_ENV_KEYS)[number], "string" | "number"]> = [
  ["modelPath", "HEARTH_KWS_MODEL_PATH", "string"], ["python", "HEARTH_KWS_PYTHON", "string"], ["script", "HEARTH_KWS_SCRIPT", "string"],
  ["threshold", "HEARTH_KWS_THRESHOLD", "number"], ["score", "HEARTH_KWS_SCORE", "number"], ["chunk", "HEARTH_KWS_CHUNK", "number"],
  ["preRollMs", "HEARTH_KWS_PREROLL_MS", "number"],
];

/** The config as the environment variables the resolver reads, so the file slots in under the real environment like every other setting. */
export function kwsConfigAsEnv(c: KwsConfig | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, key] of FIELDS) if (c?.[field] !== undefined) out[key] = String(c[field]);
  return out;
}

/** The inverse, for `hearth setup` to remember what it was run with. Absent fields stay absent. */
export function kwsConfigFromEnv(env: Record<string, string | undefined>): KwsConfig {
  const out: Record<string, string | number> = {};
  for (const [field, key, kind] of FIELDS) {
    const v = env[key]?.trim();
    if (!v) continue;
    const n = Number(v);
    if (kind === "number") { if (Number.isFinite(n)) out[field] = n; } else out[field] = v;
  }
  return out as KwsConfig;
}

export function defaultKwsScript(): string {
  // From this module, not from the working directory: dist/kws-config.js → <checkout>/tools/kws/hearth_kws.py
  return fileURLToPath(new URL("../../../tools/kws/hearth_kws.py", import.meta.url));
}

async function present(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function resolveKws(
  env: Record<string, string | undefined>,
  wakeWord: string | undefined,
  exists: (path: string) => Promise<boolean> = present,
): Promise<KwsResolution> {
  const words = wakeWordList(wakeWord);
  if (!words.length) {
    return { ok: false, why: "a wake-word detector needs a wake word to listen for (--wake <word>)" };
  }
  // English words come from the model's lexicon; Chinese characters become pinyin (the helper needs `pypinyin` for those).
  // Anything else — Japanese kana, digits, symbols — is a word this does not know how to say to the model.
  const bad = words.find((w) => !/^[A-Za-z' -]+$/.test(w) && !/^[\u4e00-\u9fff]+$/.test(w));
  if (bad) {
    return { ok: false, why: `the keyword spotter takes English words or Chinese characters (got "${bad}"); use --wake-detector transcript for another language` };
  }
  const modelDir = env.HEARTH_KWS_MODEL_PATH?.trim();
  if (!modelDir) {
    return { ok: false, why: "HEARTH_KWS_MODEL_PATH is not set (a keyword-spotting model directory, e.g. sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20)" };
  }
  if (!(await exists(modelDir))) return { ok: false, why: `HEARTH_KWS_MODEL_PATH ${modelDir} does not exist` };
  const script = env.HEARTH_KWS_SCRIPT?.trim() || defaultKwsScript();
  if (!(await exists(script))) return { ok: false, why: `the detector script ${script} does not exist (HEARTH_KWS_SCRIPT)` };

  const num = (name: string): number | undefined => {
    const v = env[name]?.trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const threshold = num("HEARTH_KWS_THRESHOLD"), score = num("HEARTH_KWS_SCORE"), chunk = num("HEARTH_KWS_CHUNK"), preRollMs = num("HEARTH_KWS_PREROLL_MS");
  if (chunk !== undefined && chunk !== 8 && chunk !== 16) return { ok: false, why: `HEARTH_KWS_CHUNK must be 8 or 16 (got ${chunk})` };
  return {
    ok: true,
    settings: {
      python: env.HEARTH_KWS_PYTHON?.trim() || "python3", script, modelDir, keywords: words,
      ...(threshold !== undefined ? { threshold } : {}), ...(score !== undefined ? { score } : {}),
      ...(chunk !== undefined ? { chunk } : {}), ...(preRollMs !== undefined ? { preRollMs } : {}),
    },
  };
}
