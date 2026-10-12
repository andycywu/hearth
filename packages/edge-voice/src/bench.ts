/**
 * The benchmark: the same audio through any engine, with the same arithmetic.
 *
 *   audio file → engine → transcript → metrics
 *
 * It exists so sherpa-onnx, whisper.cpp and Vosk can be compared on one dataset
 * rather than on three people's impressions. Nothing here is specific to an
 * engine, and nothing is estimated: every number is read off a clock or a
 * transcript.
 *
 * Two modes, because they answer different questions. **Fast** pushes audio as
 * quickly as the engine takes it, which measures throughput — the real-time
 * factor. **Realtime** paces the pushes to the audio's own duration, which is
 * what a microphone does, and is the only mode in which `finalLatencyMs` means
 * "how long after the person stopped talking did the words arrive".
 */
import type { AudioFormat, SpeechToTextEngine } from "./types.js";

export interface BenchItem {
  id: string;
  /** What was said. Compared after normalisation, so case and punctuation do not count. */
  expected: string;
  language?: string | undefined;
  tags?: string[] | undefined;
  /** Set when the item cannot be run (an unreadable or unusable recording); becomes an `error` result. */
  error?: string | undefined;
  /** PCM16 plus its format, or `undefined` when the recording does not exist yet. */
  audio?: { pcm: Uint8Array; format: AudioFormat } | undefined;
}

export interface BenchResult {
  id: string;
  backend: string;
  model: string;
  language: string | null;
  tags: string[];
  /** `ok`, `missing_audio` (no recording yet) or `error`. */
  status: "ok" | "missing_audio" | "error";
  expected: string;
  actual: string | null;
  /** Character error rate after normalisation, 0 = perfect, may exceed 1. `null` unless `ok`. */
  cer: number | null;
  audioMs: number | null;
  /** First push to final result, wall clock. */
  decodeMs: number | null;
  /** Decode time over audio time. Below 1 keeps up with a microphone. Only meaningful in fast mode. */
  rtf: number | null;
  /** End of the last pushed audio to the final result. */
  finalLatencyMs: number | null;
  rssMb: number | null;
  engineRssMb: number | null;
  error: string | null;
}

export interface BenchOptions {
  engine: SpeechToTextEngine;
  items: BenchItem[];
  /** Default 100. */
  chunkMs?: number;
  realtime?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rssMb?: () => number | undefined;
  /** Called after each item, so a long run can show progress. */
  onResult?: (r: BenchResult) => void;
}

/** Lowercase, and drop whitespace and punctuation: "Switch 到 HDMI two." ≈ "switch到hdmitwo". */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Levenshtein distance over code points. */
export function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function characterErrorRate(expected: string, actual: string): number {
  const e = [...normalizeForCompare(expected)];
  const a = [...normalizeForCompare(actual)];
  if (e.length === 0) return a.length === 0 ? 0 : 1;
  return editDistance(e, a) / e.length;
}

export async function runBenchmark(o: BenchOptions): Promise<BenchResult[]> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const chunkMs = o.chunkMs ?? 100;
  const results: BenchResult[] = [];

  await o.engine.load();
  try {
    for (const item of o.items) {
      const base: BenchResult = {
        id: item.id, backend: o.engine.backend, model: o.engine.model, language: item.language ?? null,
        tags: item.tags ?? [], status: "ok", expected: item.expected, actual: null, cer: null,
        audioMs: null, decodeMs: null, rtf: null, finalLatencyMs: null, rssMb: null, engineRssMb: null, error: null,
      };
      let result: BenchResult;
      if (item.error) {
        result = { ...base, status: "error", error: item.error };
      } else if (!item.audio) {
        result = { ...base, status: "missing_audio" };
      } else {
        try {
          result = await runOne(o.engine, item, item.audio, base, { now, sleep, chunkMs, realtime: o.realtime === true, rssMb: o.rssMb });
        } catch (err) {
          result = { ...base, status: "error", error: err instanceof Error ? err.message : String(err) };
        }
      }
      results.push(result);
      o.onResult?.(result);
    }
  } finally {
    await o.engine.close().catch(() => {});
  }
  return results;
}

async function runOne(
  engine: SpeechToTextEngine,
  item: BenchItem,
  audio: NonNullable<BenchItem["audio"]>,
  base: BenchResult,
  c: { now: () => number; sleep: (ms: number) => Promise<void>; chunkMs: number; realtime: boolean; rssMb: (() => number | undefined) | undefined },
): Promise<BenchResult> {
  const bytesPerMs = (audio.format.sampleRate * audio.format.channels * 2) / 1000;
  const step = Math.max(2, Math.floor(bytesPerMs * c.chunkMs / 2) * 2);
  const audioMs = audio.pcm.byteLength / bytesPerMs;

  const session = await engine.start();
  const started = c.now();
  try {
    for (let at = 0; at < audio.pcm.byteLength; at += step) {
      await session.push(audio.pcm.subarray(at, Math.min(at + step, audio.pcm.byteLength)));
      if (c.realtime) {
        // Hold to the audio's own clock: chunk N may not be sent before its audio would have been spoken.
        const due = started + Math.min(at + step, audio.pcm.byteLength) / bytesPerMs;
        const wait = due - c.now();
        if (wait > 0) await c.sleep(wait);
      }
    }
    const lastPushed = c.now();
    const final = await session.finish();
    const done = c.now();
    const decodeMs = done - started;
    return {
      ...base,
      actual: final.text,
      cer: characterErrorRate(item.expected, final.text),
      audioMs: Math.round(audioMs),
      decodeMs: Math.round(decodeMs),
      rtf: audioMs > 0 ? Number((decodeMs / audioMs).toFixed(3)) : null,
      finalLatencyMs: Math.round(done - lastPushed),
      rssMb: c.rssMb?.() ?? null,
      engineRssMb: engine.rssMb?.() ?? null,
    };
  } catch (err) {
    await session.abort().catch(() => {});
    throw err;
  }
}

export interface BenchSummary {
  backend: string;
  model: string;
  items: number;
  ok: number;
  missingAudio: number;
  errors: number;
  /** Mean CER over `ok` items; `null` if there were none. */
  meanCer: number | null;
  /** Items transcribed exactly (CER 0 after normalisation) over `ok`. */
  exactRate: number | null;
  meanRtf: number | null;
  finalLatencyP50Ms: number | null;
  finalLatencyP95Ms: number | null;
  maxEngineRssMb: number | null;
}

const percentile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : null;

export function summarize(results: BenchResult[]): BenchSummary {
  const ok = results.filter((r) => r.status === "ok");
  const mean = (xs: number[]): number | null => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4)) : null);
  const lat = ok.map((r) => r.finalLatencyMs!).sort((a, b) => a - b);
  const rss = ok.map((r) => r.engineRssMb).filter((x): x is number => x !== null);
  return {
    backend: results[0]?.backend ?? "", model: results[0]?.model ?? "",
    items: results.length, ok: ok.length,
    missingAudio: results.filter((r) => r.status === "missing_audio").length,
    errors: results.filter((r) => r.status === "error").length,
    meanCer: mean(ok.map((r) => r.cer!)),
    exactRate: ok.length ? Number((ok.filter((r) => r.cer === 0).length / ok.length).toFixed(4)) : null,
    meanRtf: mean(ok.map((r) => r.rtf).filter((x): x is number => x !== null)),
    finalLatencyP50Ms: percentile(lat, 50),
    finalLatencyP95Ms: percentile(lat, 95),
    maxEngineRssMb: rss.length ? Math.max(...rss) : null,
  };
}

const CSV_COLUMNS = [
  "id", "backend", "model", "language", "tags", "status", "expected", "actual", "cer",
  "audioMs", "decodeMs", "rtf", "finalLatencyMs", "rssMb", "engineRssMb", "error",
] as const;

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("|") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(results: BenchResult[]): string {
  return [CSV_COLUMNS.join(","), ...results.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}
