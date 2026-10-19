/**
 * A wake-word detector that runs on this box and sends nothing anywhere.
 *
 * The attention word used to be a filter on a transcript: every window with sound in it went to a recogniser — a paid,
 * hosted one by default — and the word was looked for in what came back. A television, a conversation in the next room
 * and a recogniser's habit of inventing "thanks for watching" for noise each cost a request. A wake word is supposed to
 * be heard *before* any of that, by something small that runs all the time and knows one phrase.
 *
 * The detector is sherpa-onnx's keyword spotter (a ~5 MB streaming model), run by `tools/kws/hearth_kws.py` as a child
 * process: raw 16 kHz PCM in on stdin, one JSON line per detection out on stdout. Python because that is what the
 * library ships for; nothing else in Hearth needs it, and a box without it says so and does not listen, rather than
 * quietly falling back to sending everything.
 *
 * It answers late. The model wants a little trailing audio before it is sure, so by the time it speaks the person has
 * usually started the command. `preRollMs` tells the pipeline to replay that much audio into the voice detector, so
 * "hearth, turn it down" said in one breath arrives whole.
 */
import type { WakeWordDetector } from "@hearthkit/edge-voice";
import { systemSpawner, type SpawnedProcess, type Spawner } from "./process.js";

export interface KwsDetectorOptions {
  /** The Python that has `sherpa-onnx` and `numpy` installed, e.g. `~/kws/venv/bin/python`. */
  python: string;
  /** Path to `tools/kws/hearth_kws.py`. */
  script: string;
  /** A keyword-spotting model directory (e.g. `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`). */
  modelDir: string;
  /** English words the model's lexicon knows. */
  keywords: string[];
  /** Lower fires more easily. The model's own default, 0.25, is what was measured; 0.1 and 0.05 did worse. */
  threshold?: number;
  score?: number;
  /** The model's chunk size, 16 or 8. */
  chunk?: number | string;
  /** Audio replayed to the voice detector when the word fires. Default 800 ms. */
  preRollMs?: number;
  /** The longest wait for the model to load. Default 90 s: it took ~10 s on a Pi 3B. */
  loadTimeoutMs?: number;
  spawn?: Spawner;
  /** Every JSON line the helper wrote, for a log. */
  onEvent?: (event: Record<string, unknown>) => void;
}

export type KwsDetector = WakeWordDetector & {
  /** Detections so far. */
  readonly detections: number;
  /** Chunks dropped because the helper was not keeping up, or was not ready. */
  readonly dropped: number;
};

export function createKwsDetector(o: KwsDetectorOptions): KwsDetector {
  const spawn = o.spawn ?? systemSpawner;
  const preRollMs = o.preRollMs ?? 800;
  let child: SpawnedProcess | undefined;
  let ready = false;
  let pending = false;
  let closed = false;
  let failure: Error | undefined;
  let detections = 0;
  let dropped = 0;

  const args = (): string[] => [
    o.script, "--model-dir", o.modelDir,
    ...o.keywords.flatMap((k) => ["--keyword", k]),
    ...(o.threshold !== undefined ? ["--threshold", String(o.threshold)] : []),
    ...(o.score !== undefined ? ["--score", String(o.score)] : []),
    ...(o.chunk !== undefined ? ["--chunk", String(o.chunk)] : []),
  ];

  return {
    name: `kws:${o.keywords.join("+")}`,
    preRollMs,
    get detections() { return detections; },
    get dropped() { return dropped; },

    async load() {
      if (child) return;
      const proc = spawn(o.python, args(), { stdin: "pipe" });
      child = proc;
      let announce!: { resolve(): void; reject(err: Error): void };
      const loaded = new Promise<void>((resolve, reject) => { announce = { resolve, reject }; });

      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        const handle = (line: string): void => {
          if (!line.trim()) return;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }   // a stray library message is not a protocol line
          o.onEvent?.(event);
          if (event.event === "ready") { ready = true; announce.resolve(); }
          else if (event.event === "keyword") { detections++; pending = true; }
          else if (event.event === "error") {
            failure = new Error(`wake-word detector: ${String(event.message)}`);
            announce.reject(failure);
          }
        };
        try {
          for await (const part of proc.stdout) {
            buffer += decoder.decode(part, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) { handle(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
          }
          handle(buffer);
        } catch { /* a stream that failed ends the process; exit says so */ }
      })();

      void proc.exit.then((code) => {
        if (closed) return;
        // Exiting while the pipeline is running is a fault the pipeline must hear about: a wake word that stopped
        // detecting looks exactly like a quiet room, and "it never woke up" is the worst thing to debug.
        failure ??= new Error(`wake-word detector exited${code === null ? "" : ` (code ${code})`}: ${proc.stderr().trim().slice(-400) || "no output"}`);
        announce.reject(failure);
      });

      const timeout = new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`wake-word detector did not load within ${(o.loadTimeoutMs ?? 90_000) / 1000} s`)), o.loadTimeoutMs ?? 90_000);
        void loaded.finally(() => clearTimeout(t)).catch(() => {});
      });
      try { await Promise.race([loaded, timeout]); }
      catch (err) { proc.kill(); throw err; }
    },

    accept(chunk) {
      if (closed) return false;
      if (failure) throw failure;
      if (!ready || !child) { dropped++; return false; }       // audio before the model is up is not buffered: it would arrive late
      if (child.write?.(chunk) === false) dropped++;
      if (!pending) return false;
      pending = false;
      return true;
    },

    reset() { pending = false; },

    async close() {
      if (closed) return;
      closed = true;
      child?.endInput?.();
      child?.kill();
      await Promise.race([child?.exit, new Promise((r) => setTimeout(r, 1_000))]);
    },
  };
}
