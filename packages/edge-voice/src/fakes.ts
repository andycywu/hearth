/**
 * Scripted stand-ins for every stage, so the pipeline runs in CI with no
 * microphone, no model and no clock. They are exported — a backend's own tests
 * use them to drive the pipeline the same way.
 */
import type {
  AudioFormat, AudioInput, SpeechToTextEngine, SttResult, SttSession, VadEvent, VoiceActivityDetector,
  WakeWordDetector,
} from "./types.js";

export const FORMAT_16K_MONO: AudioFormat = { sampleRate: 16_000, channels: 1 };

/** `ms` of zero-valued PCM16 (the content is irrelevant to the fakes). */
export function pcm(ms: number, format: AudioFormat = FORMAT_16K_MONO): Uint8Array {
  return new Uint8Array(Math.round((format.sampleRate * format.channels * 2 * ms) / 1000));
}

/** Yields the given chunks, then ends — or rejects after `failAfter` chunks, like a device that went away. */
export function fakeAudioInput(
  chunks: Uint8Array[],
  opts: { failAfter?: number; format?: AudioFormat } = {},
): AudioInput & { closed: boolean } {
  const self = {
    format: opts.format ?? FORMAT_16K_MONO,
    closed: false,
    open(): AsyncIterable<Uint8Array> {
      return (async function* () {
        let i = 0;
        for (const c of chunks) {
          if (opts.failAfter !== undefined && i >= opts.failAfter) throw new Error("audio device disconnected");
          yield c;
          i++;
        }
      })();
    },
    async close() { self.closed = true; },
  };
  return self;
}

/** Returns the scripted events for the Nth chunk it is given (0-based); nothing for the rest. */
export function fakeVad(script: Record<number, VadEvent[]>): VoiceActivityDetector {
  let n = 0;
  return {
    name: "fake-vad",
    accept: () => script[n++] ?? [],
    reset: () => {},
  };
}

/** Fires on the Nth chunk it is given (0-based). */
export function fakeWake(firesOnChunk: number): WakeWordDetector & { seen: number } {
  const self = {
    name: "fake-wake",
    seen: 0,
    accept: () => self.seen++ === firesOnChunk,
    reset: () => {},
  };
  return self;
}

export interface FakeSttOptions {
  streaming?: boolean;
  /** Final text per utterance, in order. */
  finals: string[];
  /** Partial text returned by successive `push` calls, if any. */
  partials?: string[];
  language?: string;
  /** Utterance indices whose `finish()` throws. */
  failOnFinish?: number[];
  failOnLoad?: boolean;
}

export function fakeStt(o: FakeSttOptions): SpeechToTextEngine & { starts: number; loaded: boolean; closed: boolean } {
  const self = {
    backend: "fake",
    model: "fake-model",
    streaming: o.streaming ?? true,
    starts: 0,
    loaded: false,
    closed: false,
    async load() {
      if (o.failOnLoad) throw new Error("model not found");
      self.loaded = true;
    },
    async start(): Promise<SttSession> {
      const index = self.starts++;
      let pushes = 0;
      return {
        async push(): Promise<SttResult[]> {
          const p = o.partials?.[pushes++];
          return p === undefined ? [] : [{ text: p, isFinal: false, confidence: null }];
        },
        async finish(): Promise<SttResult> {
          if (o.failOnFinish?.includes(index)) throw new Error("engine crashed");
          return { text: o.finals[index] ?? "", language: o.language, isFinal: true, confidence: null };
        },
        async abort() {},
      };
    },
    async close() { self.closed = true; },
  };
  return self;
}
