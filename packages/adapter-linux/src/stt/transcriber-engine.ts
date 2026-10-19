/**
 * A transcriber — an OpenAI-schema endpoint, hosted or on the LAN — as a speech-to-text engine for the edge pipeline.
 *
 * The pipeline gives an engine one utterance at a time, already bounded by a voice detector and, when there is a wake word,
 * already addressed to us. A hosted transcriber is not streaming: it takes a finished recording. So this collects the
 * utterance and uploads it once, at its end — which is the property that makes the bill proportional to what was said *to
 * Hearth* rather than to what was said in the room.
 *
 * Two further things it will not send, because each is a request that cannot be a command:
 *  - a recording shorter than `minSpeechMs` (a click, a cough, the voice detector's pre-roll with nothing after it);
 *  - one whose level never rose above `minRms` (the same silence gate the older windowed path used, measured on what the
 *    voice detector kept rather than on a fixed five seconds).
 * Both are reported as an empty result, which the pipeline logs as \`stt_empty\`: visible, and free.
 */
import { encodeWav, rmsOfPcm16, type AudioFormat, type SpeechToTextEngine, type SttResult, type SttSession } from "@hearthkit/edge-voice";
import type { Transcriber } from "../voice.js";

export interface TranscriberEngineOptions {
  transcribe: Transcriber;
  format: AudioFormat;
  /** Appears on every transcript and log line: `openai`, `http`. */
  backend?: string;
  model?: string;
  /** Default 400 ms. */
  minSpeechMs?: number;
  /** Default 0.01, the same threshold as the windowed path's silence gate. */
  minRms?: number;
  /** An utterance is cut here, so a stuck voice detector cannot upload a minute of room noise. Default 20 s. */
  maxSpeechMs?: number;
  /** Told whenever an utterance is held back, and why — so "nothing happened" can be told from "nothing was sent". */
  onSkip?: (reason: "too-short" | "too-quiet", detail: { ms: number; rms: number }) => void;
}

export function createTranscriberEngine(o: TranscriberEngineOptions): SpeechToTextEngine {
  const minMs = o.minSpeechMs ?? 400;
  const minRms = o.minRms ?? 0.01;
  const maxBytes = Math.round(((o.format.sampleRate * o.format.channels * 2) / 1000) * (o.maxSpeechMs ?? 20_000));
  const bytesPerMs = (o.format.sampleRate * o.format.channels * 2) / 1000;

  return {
    backend: o.backend ?? "http",
    model: o.model ?? "whisper-1",
    streaming: false,
    async load() { /* nothing to load: the model is somewhere else */ },
    async start(): Promise<SttSession> {
      const parts: Uint8Array[] = [];
      let bytes = 0;
      return {
        async push(chunk): Promise<SttResult[]> {
          if (bytes < maxBytes) { parts.push(chunk); bytes += chunk.byteLength; }
          return [];                                   // not streaming: no partials
        },
        async finish(): Promise<SttResult> {
          const pcm = new Uint8Array(bytes);
          let at = 0;
          for (const p of parts) { pcm.set(p, at); at += p.byteLength; }
          const ms = bytes / bytesPerMs;
          const rms = bytes ? rmsOfPcm16(pcm) : 0;
          const empty: SttResult = { text: "", isFinal: true, confidence: null };
          if (ms < minMs) { o.onSkip?.("too-short", { ms, rms }); return empty; }
          if (rms < minRms) { o.onSkip?.("too-quiet", { ms, rms }); return empty; }
          const text = (await o.transcribe(encodeWav(pcm, o.format), { encoding: "S16_LE", rate: o.format.sampleRate, channels: o.format.channels })).trim();
          return { text, isFinal: true, confidence: null };
        },
        async abort() { parts.length = 0; bytes = 0; },
      };
    },
    async close() { /* nothing held */ },
  };
}
