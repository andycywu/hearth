/**
 * Orchestration: pull audio, gate it, cut it into utterances, recognise them.
 *
 * Nothing here knows an engine, a microphone or a clock — all three are
 * injected, which is why the whole pipeline is tested without hardware.
 *
 * Two behaviours worth knowing before reading on:
 *
 * - **Wake word on means STT stays idle.** Until the detector fires, chunks go
 *   to the detector and nowhere else; no session is opened and no inference
 *   runs. Only the detector is "always on".
 * - **No VAD means one long session.** A streaming engine with its own
 *   endpointing can be fed the raw stream; its finals are passed through.
 *   A non-streaming engine without a VAD would never produce a result, and
 *   `createPipeline` refuses that combination rather than run silently.
 */
import type {
  AudioInput, AudioPreprocessor, LogEvent, SpeechToTextEngine, SttResult, SttSession,
  Transcript, VadEvent, VoiceActivityDetector, WakeWordDetector,
} from "./types.js";

export interface PipelineOptions {
  input: AudioInput;
  stt: SpeechToTextEngine;
  vad?: VoiceActivityDetector;
  preprocessor?: AudioPreprocessor;
  wake?: WakeWordDetector;
  /** How long after the wake word an utterance may start. Default 8 s. */
  wakeWindowMs?: number;
  /** Give up after this many utterances in a row fail in the engine. Default 3. */
  maxConsecutiveSttFailures?: number;
  /** Wall clock, ms. Injected so latency is testable. */
  now?: () => number;
  /** Resident set size in MB, if the platform can say. */
  rssMb?: () => number | undefined;
  log?: (e: LogEvent) => void;
}

export interface Pipeline {
  /** Resolves when the input ends or the pipeline stops; rejects on a fault it cannot absorb. */
  run(): Promise<void>;
  stop(): Promise<void>;
  onTranscript(cb: (t: Transcript) => void): () => void;
}

export function createPipeline(opts: PipelineOptions): Pipeline {
  const { input, stt, vad, preprocessor, wake } = opts;
  if (!vad && !stt.streaming) {
    throw new Error(
      `STT backend "${stt.backend}" does not stream and no VAD was given: there is no way to ` +
      "know where an utterance ends. Enable VAD or choose a streaming backend.",
    );
  }
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const wakeWindowMs = opts.wakeWindowMs ?? 8_000;
  const maxFailures = opts.maxConsecutiveSttFailures ?? 3;
  const listeners = new Set<(t: Transcript) => void>();
  const bytesPerMs = (input.format.sampleRate * input.format.channels * 2) / 1000;

  let stopped = false;
  let streamMs = 0;                 // audio consumed so far, by byte count
  let armedUntilMs = wake ? -1 : Infinity;
  let session: SttSession | undefined;
  let utteranceStartMs = 0;
  let utteranceWall = 0;
  let failures = 0;

  const emit = (r: SttResult, startMs: number, endMs: number): Transcript => {
    const t: Transcript = {
      text: r.text, language: r.language ?? null, isFinal: r.isFinal, confidence: r.confidence,
      startTimeMs: startMs, endTimeMs: endMs, backend: stt.backend,
    };
    for (const cb of listeners) cb(t);
    return t;
  };

  const fail = (stage: string, err: unknown): void => {
    failures++;
    log({
      event: "stt_error", backend: stt.backend, stage,
      error: err instanceof Error ? err.message : String(err), consecutive: failures,
    });
  };

  const openSession = async (atMs: number): Promise<void> => {
    utteranceStartMs = atMs;
    utteranceWall = now();
    try { session = await stt.start(); } catch (err) { session = undefined; fail("start", err); }
  };

  const closeSession = async (endMs: number, vadEndedWall: number): Promise<void> => {
    const s = session;
    session = undefined;
    if (!s) return;
    try {
      const r = await s.finish();
      const done = now();
      failures = 0;
      if (r.text.trim()) {
        const t = emit(r, utteranceStartMs, endMs);
        log({
          event: "stt_result", backend: stt.backend, model: stt.model, text: t.text, language: t.language,
          audio_duration_ms: Math.round(endMs - utteranceStartMs),
          stt_latency_ms: Math.round(done - vadEndedWall),
          total_latency_ms: Math.round(done - utteranceWall),
          rss_mb: opts.rssMb?.(),
          engine_rss_mb: stt.rssMb?.(),
        });
      } else {
        log({ event: "stt_empty", backend: stt.backend, audio_duration_ms: Math.round(endMs - utteranceStartMs) });
      }
    } catch (err) { fail("finish", err); }
  };

  const handleVad = async (events: VadEvent[]): Promise<void> => {
    for (const ev of events) {
      if (ev.type === "speech_started") {
        await openSession(ev.atMs);
      } else if (ev.type === "speech_chunk") {
        const s = session;
        if (!s) continue;
        try {
          for (const r of await s.push(ev.chunk)) emit({ ...r, isFinal: false }, utteranceStartMs, ev.atMs);
        } catch (err) {
          fail("push", err);
          session = undefined;
          await s.abort().catch(() => {});
        }
      } else {
        await closeSession(ev.atMs, now());
        if (wake) armedUntilMs = -1;       // one command per wake word
      }
    }
  };

  return {
    onTranscript(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    async stop() {
      stopped = true;
      await session?.abort().catch(() => {});
      session = undefined;
      await input.close();
    },

    async run() {
      await stt.load();
      log({
        event: "pipeline_started", backend: stt.backend, model: stt.model,
        vad: vad?.name ?? null, wake: wake?.name ?? null, rss_mb: opts.rssMb?.(), engine_rss_mb: stt.rssMb?.(),
      });
      let single: SttSession | undefined;      // the no-VAD session
      try {
        for await (const raw of input.open()) {
          if (stopped) break;
          const chunk = preprocessor ? preprocessor.process(raw) : raw;
          streamMs += chunk.byteLength / bytesPerMs;

          if (wake && streamMs > armedUntilMs) {
            if (wake.accept(chunk)) {
              armedUntilMs = streamMs + wakeWindowMs;
              vad?.reset();
              log({ event: "wake", detector: wake.name, at_ms: Math.round(streamMs) });
            }
            continue;                             // STT stays idle until armed
          }

          if (vad) {
            await handleVad(vad.accept(chunk));
          } else {
            try {
              single ??= await stt.start();
              for (const r of await single.push(chunk)) {
                if (r.isFinal && !r.text.trim()) continue;
                if (r.isFinal) failures = 0;
                emit(r, utteranceStartMs, streamMs);
                if (r.isFinal) utteranceStartMs = streamMs;
              }
            } catch (err) { fail("push", err); single = undefined; }
          }
          if (failures >= maxFailures) {
            throw new Error(`STT backend "${stt.backend}" failed ${failures} times in a row; stopping`);
          }
        }
        if (session) await closeSession(streamMs, now());   // input ended mid-utterance
      } finally {
        await session?.abort().catch(() => {});
        await single?.abort().catch(() => {});
        await stt.close().catch(() => {});
        log({ event: "pipeline_stopped", backend: stt.backend });
      }
    },
  };
}
