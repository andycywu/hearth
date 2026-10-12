/**
 * A voice-activity detector that listens for loudness and nothing else.
 *
 * This is the zero-dependency VAD. A neural one (silero) would need an ONNX
 * runtime inside Node, which this repo does not carry; the interface is the
 * seam for swapping one in. What this one cannot do is tell speech from other
 * sound: a television in the next room, a door, a dog. It will open an STT
 * session for any of them, and the recogniser — not this — decides there was
 * nothing to say. That is a cost in CPU, not in correctness, and it is why the
 * threshold is a measured number rather than a guess: on the living-room Pi
 * the ReSpeaker's quiet-room floor was rms 0.003–0.0085 (2026-10-05).
 *
 * The shape of an utterance: speech starts after `startMs` of consecutive
 * loud audio, the audio just before it (`preRollMs`) is handed over with the
 * first chunk so the first syllable is not clipped, and it ends after
 * `hangoverMs` of quiet — the trailing quiet is sent too, because a streaming
 * recogniser's endpointing wants to see it.
 */
import type { AudioFormat, VadEvent, VoiceActivityDetector } from "./types.js";

export interface EnergyVadOptions {
  format: AudioFormat;
  /** RMS as a fraction of full scale. Default 0.01, about -40 dBFS. */
  threshold?: number;
  /** Loud for this long before it counts as speech. Default 150 ms. */
  startMs?: number;
  /** Quiet for this long ends the utterance. Default 600 ms. */
  hangoverMs?: number;
  /** Audio kept from before the trigger. Default 300 ms. */
  preRollMs?: number;
  /** An utterance is cut here no matter what — a fan is not a sentence. Default 15 s. */
  maxUtteranceMs?: number;
}

/** RMS of 16-bit little-endian PCM, 0..1. */
export function rmsOfPcm16(chunk: Uint8Array): number {
  const n = chunk.byteLength >> 1;
  if (n === 0) return 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export function createEnergyVad(o: EnergyVadOptions): VoiceActivityDetector {
  const threshold = o.threshold ?? 0.01;
  const startMs = o.startMs ?? 150;
  const hangoverMs = o.hangoverMs ?? 600;
  const preRollMs = o.preRollMs ?? 300;
  const maxMs = o.maxUtteranceMs ?? 15_000;
  const bytesPerMs = (o.format.sampleRate * o.format.channels * 2) / 1000;

  let clock = 0;                              // ms of audio seen
  let speaking = false;
  let loudRun: Uint8Array[] = [];             // loud chunks not yet promoted to speech
  let loudMs = 0;
  let preRoll: Uint8Array[] = [];             // quiet chunks before the trigger
  let preRollMsHeld = 0;
  let quietMs = 0;
  let utteranceStart = 0;

  const concat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
  };

  const remember = (chunk: Uint8Array, ms: number): void => {
    preRoll.push(chunk);
    preRollMsHeld += ms;
    while (preRoll.length > 1 && preRollMsHeld - preRoll[0]!.byteLength / bytesPerMs >= preRollMs) {
      preRollMsHeld -= preRoll[0]!.byteLength / bytesPerMs;
      preRoll.shift();
    }
  };

  const reset = (): void => {
    speaking = false; loudRun = []; loudMs = 0; preRoll = []; preRollMsHeld = 0; quietMs = 0;
  };

  return {
    name: "energy",
    reset,
    accept(chunk) {
      const ms = chunk.byteLength / bytesPerMs;
      clock += ms;
      const loud = rmsOfPcm16(chunk) >= threshold;
      const events: VadEvent[] = [];

      if (!speaking) {
        if (!loud) {
          // A quiet chunk breaks the run: its loud predecessors were a click, not speech.
          for (const c of loudRun) remember(c, c.byteLength / bytesPerMs);
          loudRun = []; loudMs = 0;
          remember(chunk, ms);
          return events;
        }
        loudRun.push(chunk);
        loudMs += ms;
        if (loudMs < startMs) return events;
        speaking = true;
        quietMs = 0;
        const lead = concat([...preRoll, ...loudRun]);
        utteranceStart = Math.max(0, clock - lead.byteLength / bytesPerMs);
        events.push({ type: "speech_started", atMs: utteranceStart });
        events.push({ type: "speech_chunk", chunk: lead, atMs: clock });
        preRoll = []; preRollMsHeld = 0; loudRun = []; loudMs = 0;
        return events;
      }

      events.push({ type: "speech_chunk", chunk, atMs: clock });
      quietMs = loud ? 0 : quietMs + ms;
      if (quietMs >= hangoverMs || clock - utteranceStart >= maxMs) {
        events.push({ type: "speech_ended", atMs: clock });
        speaking = false; quietMs = 0;
      }
      return events;
    },
  };
}
