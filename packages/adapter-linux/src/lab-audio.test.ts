import { describe, expect, it } from "vitest";
import type { Runner } from "./run.js";
import { createAudioLab, levelsOfWav } from "./lab-audio.js";

function wav(samples: number[], rate = 16_000, bits = 16): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const dv = new DataView(data.buffer);
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true));
  const head = new Uint8Array(44);
  const v = new DataView(head.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => { head[at + i] = c.charCodeAt(0); });
  put(0, "RIFF"); v.setUint32(4, 36 + data.length, true); put(8, "WAVE"); put(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, bits, true);
  put(36, "data"); v.setUint32(40, data.length, true);
  const out = new Uint8Array(44 + data.length);
  out.set(head); out.set(data, 44);
  return out;
}

describe("levelsOfWav", () => {
  it("reports rms and peak in dB relative to full scale", () => {
    const l = levelsOfWav(wav(Array(16_000).fill(16384)));      // constant half scale, one second
    expect(l.seconds).toBe(1);
    expect(l.peakDb).toBe(-6);
    expect(l.rmsDb).toBe(-6);
    expect(l.peak).toBeCloseTo(0.5);
  });

  it("tells a click in a quiet room from speech by the gap between peak and rms", () => {
    const quietWithClick = Array(16_000).fill(30) as number[];
    quietWithClick[100] = 20_000;
    const l = levelsOfWav(wav(quietWithClick));
    expect(l.peakDb!).toBeGreaterThan(-5);
    expect(l.peakDb! - l.rmsDb!).toBeGreaterThan(30);     // a click: loud peak, quiet average
  });

  it("gives null, not -Infinity, for digital silence", () => {
    expect(levelsOfWav(wav(Array(1_000).fill(0)))).toMatchObject({ rmsDb: null, peakDb: null });
  });

  it("refuses what it cannot measure, and says why", () => {
    expect(() => levelsOfWav(new Uint8Array(10))).toThrow(/not a WAV/);
    expect(() => levelsOfWav(wav([1, 2], 16_000, 24))).toThrow(/24-bit/);
  });
});

describe("audio lab", () => {
  const ok: Runner = async () => ({ code: 0, stdout: "", stderr: "" });

  it("records, measures, keeps the clip, and shows the command it ran", async () => {
    const calls: string[] = [];
    const lab = createAudioLab({
      device: "plughw:2,0", path: "/tmp/x.wav",
      run: async (c, a) => { calls.push([c, ...a].join(" ")); return { code: 0, stdout: "", stderr: "" }; },
      readCapture: async () => wav(Array(16_000).fill(1000)),
    });
    const r = await lab.record(3);
    expect(r.ok).toBe(true);
    expect(r.levels?.seconds).toBe(1);
    expect(r.cmdline).toBe("arecord -D plughw:2,0 -f S16_LE -r 16000 -c 1 -d 3 -q /tmp/x.wav");
    expect(calls[0]).toBe(r.cmdline);
    expect(lab.last()).toBeDefined();
  });

  it("clamps the length: a stuck button must not record for an hour", async () => {
    const calls: string[] = [];
    const lab = createAudioLab({ run: async (c, a) => { calls.push(a.join(" ")); return { code: 0, stdout: "", stderr: "" }; }, readCapture: async () => wav([1]) });
    await lab.record(9_999);
    expect(calls[0]).toContain("-d 15");
  });

  it("returns arecord's own words when the device is busy", async () => {
    const lab = createAudioLab({ run: async () => ({ code: 1, stdout: "", stderr: "arecord: main:831: audio open error: Device or resource busy" }) });
    const r = await lab.record(3);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/Device or resource busy/);
    expect(lab.last()).toBeUndefined();
  });

  it("will not play what was never recorded", async () => {
    expect((await createAudioLab({ run: ok }).play())).toMatchObject({ ok: false, error: "nothing recorded yet" });
  });

  it("speaks with espeak-ng, passing the text after -- so it can never be read as a flag", async () => {
    const calls: string[][] = [];
    const lab = createAudioLab({ run: async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: "", stderr: "" }; } });
    await lab.say("--stdout hello", { voice: "cmn" });
    expect(calls[0]).toEqual(["espeak-ng", "-v", "cmn", "--", "--stdout hello"]);
    expect((await lab.say("   "))).toMatchObject({ ok: false });
    // A voice that is not a voice name is refused, not quietly dropped: the page is told, and nothing runs.
    expect(await lab.say("x", { voice: "not a voice; rm" })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it("speaks at the speed and pitch it is given", async () => {
    const calls: string[][] = [];
    const lab = createAudioLab({ run: async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: "", stderr: "" }; } });
    await lab.say("hi", { voice: "en-us+f3", speed: 140, pitch: 70 });
    expect(calls[0]).toEqual(["espeak-ng", "-v", "en-us+f3", "-s", "140", "-p", "70", "--", "hi"]);
    expect(await lab.say("hi", { speed: 9_000 })).toMatchObject({ ok: false });
  });
});
