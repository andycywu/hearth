import { describe, expect, it } from "vitest";
import { createWavFileInput } from "./wav-input.js";

function wav(ms: number, rate = 16_000, channels = 1): Uint8Array {
  const data = new Uint8Array(Math.round((rate * channels * 2 * ms) / 1000)).fill(1);
  const head = new Uint8Array(44);
  const v = new DataView(head.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => { head[at + i] = c.charCodeAt(0); });
  put(0, "RIFF"); v.setUint32(4, 36 + data.length, true); put(8, "WAVE"); put(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  put(36, "data"); v.setUint32(40, data.length, true);
  const out = new Uint8Array(44 + data.length);
  out.set(head); out.set(data, 44);
  return out;
}

const FORMAT = { sampleRate: 16_000, channels: 1 };

describe("a WAV file as a microphone", () => {
  it("plays the whole file in 100 ms chunks and then ends", async () => {
    const input = createWavFileInput({ path: "x.wav", format: FORMAT, read: async () => wav(1_000), paced: false });
    const sizes: number[] = [];
    for await (const c of input.open()) sizes.push(c.byteLength);
    expect(sizes).toHaveLength(10);
    expect(sizes.every((s) => s === 3_200)).toBe(true);
  });

  it("paces itself to the audio's own clock, so a gated listener sees it at the speed a person speaks", async () => {
    const slept: number[] = [];
    const input = createWavFileInput({ path: "x.wav", format: FORMAT, read: async () => wav(500), sleep: async (ms) => { slept.push(ms); } });
    for await (const _ of input.open()) { /* drain */ }
    expect(slept.reduce((a, b) => a + b, 0)).toBe(500);
  });

  it("refuses a file in another rate rather than converting it", async () => {
    const input = createWavFileInput({ path: "cd.wav", format: FORMAT, read: async () => wav(100, 44_100, 2), paced: false });
    await expect((async () => { for await (const _ of input.open()) { /* drain */ } })()).rejects.toThrow(/44100 Hz x 2ch.*does not resample/);
  });

  it("stops when closed", async () => {
    const input = createWavFileInput({ path: "x.wav", format: FORMAT, read: async () => wav(1_000), paced: false });
    let n = 0;
    for await (const _ of input.open()) { if (++n === 3) await input.close(); }
    expect(n).toBe(3);
  });
});
