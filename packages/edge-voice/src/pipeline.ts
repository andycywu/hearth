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
  /**
   * Accept the next utterance without the wake word — for a host that has just asked a question ("Yes?") and is
   * waiting for the answer. Like a detection, it lasts `wakeWindowMs` of audio and one utterance. Without a wake word
   * configured everything is already accepted and this does nothing.
   */
  arm(): void;
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
  // The last `preRollMs` of audio, for a wake word that answers late (see WakeWordDetector.preRollMs).
  const preRollMs = wake?.preRollMs ?? 0;
  const recent: Array<{ chunk: Uint8Array; ms: number }> = [];
  let recentMs = 0;
  const remember = (chunk: Uint8Array, ms: number): void => {
    if (preRollMs <= 0) return;
    recent.push({ chunk, ms });
    recentMs += ms;
    while (recent.length > 1 && recentMs - recent[0]!.ms >= preRollMs) recentMs -= recent.shift()!.ms;
  };

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
        log({ event: "speech_started", at_ms: Math.round(ev.atMs) });
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
        // Speech over, words not yet worked out: the interval a status light can show as "recognising".
        log({ event: "speech_ended", at_ms: Math.round(ev.atMs) });
        await closeSession(ev.atMs, now());
        if (wake) armedUntilMs = -1;       // one command per wake word
      }
    }
  };

  return {
    onTranscript(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    arm() {
      if (!wake) return;
      armedUntilMs = streamMs + wakeWindowMs;
      vad?.reset();
      recent.length = 0; recentMs = 0;      // what was heard before the host asked is not the answer
      log({ event: "armed", reason: "host", at_ms: Math.round(streamMs) });
    },

    async stop() {
      stopped = true;
      await session?.abort().catch(() => {});
      session = undefined;
      await input.close();
    },

    async run() {
      // Loading is the slow, silent part (~20 s on a Pi 3B): say it has begun, so something can show it.
      log({ event: "pipeline_loading", backend: stt.backend, model: stt.model });
      await stt.load();
      await wake?.load?.();      // both are awaited before the first chunk; the slower of the two is the wait a person feels
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
              // What was said while the detector was making up its mind goes to the voice detector first, in order,
              // then this chunk — so the command starts where the person started it, not where the detector decided.
              const replay = recent.map((r) => r.chunk);
              recent.length = 0; recentMs = 0;
              if (vad && preRollMs > 0) {      // a detector that did not ask for a replay gets the old behaviour: audio resumes after the word
                for (const old of replay) await handleVad(vad.accept(old));
                await handleVad(vad.accept(chunk));
              }
            } else {
              remember(chunk, chunk.byteLength / bytesPerMs);
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
        await wake?.close?.().catch(() => {});
        log({ event: "pipeline_stopped", backend: stt.backend });
      }
    },
  };
}
