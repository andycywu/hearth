import { describe, expect, it } from "vitest";
import { createEnergyVad, rmsOfPcm16 } from "./energy-vad.js";
import { FORMAT_16K_MONO, pcm } from "./fakes.js";
import type { VadEvent } from "./types.js";

/** `ms` of a constant-amplitude signal, as a fraction of full scale. */
function tone(ms: number, amplitude: number): Uint8Array {
  const out = pcm(ms);
  const view = new DataView(out.buffer);
  for (let i = 0; i < out.byteLength / 2; i++) view.setInt16(i * 2, Math.round(amplitude * 32767), true);
  return out;
}

const run = (chunks: Uint8Array[], o = {}): VadEvent[] => {
  const vad = createEnergyVad({ format: FORMAT_16K_MONO, ...o });
  return chunks.flatMap((c) => vad.accept(c));
};
const types = (e: VadEvent[]) => e.map((x) => x.type);

describe("rmsOfPcm16", () => {
  it("measures a constant signal as its amplitude and silence as zero", () => {
    expect(rmsOfPcm16(tone(100, 0.5))).toBeCloseTo(0.5, 3);
    expect(rmsOfPcm16(pcm(100))).toBe(0);
  });

  it("ignores a dangling odd byte rather than reading past the sample", () => {
    expect(rmsOfPcm16(new Uint8Array(3))).toBe(0);
  });
});

describe("energy VAD", () => {
  it("stays silent on a quiet room", () => {
    expect(run(Array.from({ length: 30 }, () => tone(100, 0.005)))).toEqual([]);
  });

  it("does not take a click for speech", () => {
    const events = run([tone(100, 0.005), tone(50, 0.5), ...Array.from({ length: 10 }, () => tone(100, 0.005))]);
    expect(events).toEqual([]);
  });

  it("starts after sustained sound, hands over the pre-roll, and ends after the hangover", () => {
    const quiet = () => tone(100, 0.003);
    const events = run([
      quiet(), quiet(), quiet(), quiet(),                    // 400 ms of room, 300 ms of it kept
      tone(100, 0.2), tone(100, 0.2),                        // trigger at 150 ms
      tone(100, 0.2),
      ...Array.from({ length: 7 }, quiet),                   // 700 ms of quiet > 600 ms hangover
    ]);
    expect(types(events)[0]).toBe("speech_started");
    expect(types(events).at(-1)).toBe("speech_ended");
    expect(types(events).filter((t) => t === "speech_ended")).toHaveLength(1);

    const first = events.find((e) => e.type === "speech_chunk");
    // 300 ms pre-roll + the 200 ms of loud audio that proved it, 16 kHz × 2 bytes.
    expect(first && first.type === "speech_chunk" ? first.chunk.byteLength : 0).toBe(((300 + 200) * 32));
    const started = events[0]!;
    expect(started.type === "speech_started" ? started.atMs : -1).toBe(100);
  });

  it("sends the trailing quiet too, so the recogniser can see the utterance end", () => {
    const events = run([tone(200, 0.2), ...Array.from({ length: 6 }, () => tone(100, 0.001))]);
    const chunks = events.filter((e) => e.type === "speech_chunk");
    expect(chunks).toHaveLength(1 + 6);
  });

  it("cuts an utterance that never stops", () => {
    const events = run(Array.from({ length: 40 }, () => tone(100, 0.2)), { maxUtteranceMs: 2_000 });
    expect(events.filter((e) => e.type === "speech_ended").length).toBeGreaterThanOrEqual(1);
  });

  it("reset forgets an utterance in progress", () => {
    const vad = createEnergyVad({ format: FORMAT_16K_MONO });
    vad.accept(tone(200, 0.2));
    vad.reset();
    expect(vad.accept(tone(100, 0.001))).toEqual([]);
  });
});
