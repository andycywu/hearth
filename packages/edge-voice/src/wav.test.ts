import { describe, expect, it } from "vitest";
import { encodeWav, parseWav } from "./wav.js";

describe("encodeWav", () => {
  it("round-trips through parseWav, byte for byte", () => {
    const pcm = new Uint8Array([1, 0, 255, 127, 0, 128, 2, 1]);
    const wav = encodeWav(pcm, { sampleRate: 16_000, channels: 1 });
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    const back = parseWav(wav);
    expect(back.format).toEqual({ sampleRate: 16_000, channels: 1 });
    expect(Array.from(back.pcm)).toEqual(Array.from(pcm));
    expect(back.durationMs).toBeCloseTo((4 / 16_000) * 1000);
  });

  it("writes the header a transcription endpoint reads: RIFF/WAVE, PCM, the rate, 16 bits", () => {
    const wav = encodeWav(new Uint8Array(32_000), { sampleRate: 16_000, channels: 1 });
    const text = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    const view = new DataView(wav.buffer);
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect([view.getUint16(20, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(34, true)]).toEqual([1, 16_000, 32_000, 16]);
    expect(view.getUint32(4, true)).toBe(36 + 32_000);
  });
});
