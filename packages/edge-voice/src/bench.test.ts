import { describe, expect, it } from "vitest";
import { characterErrorRate, editDistance, normalizeForCompare, runBenchmark, summarize, toCsv, type BenchItem } from "./bench.js";
import { FORMAT_16K_MONO, fakeStt, pcm } from "./fakes.js";
import { parseWav } from "./wav.js";

const item = (id: string, expected: string, ms = 1000): BenchItem => ({
  id, expected, language: "zh", tags: ["power"], audio: { pcm: pcm(ms), format: FORMAT_16K_MONO },
});

describe("character error rate", () => {
  it("ignores case, spaces and punctuation — a model that shouts NETFLIX is not wrong", () => {
    expect(normalizeForCompare("Switch 到 HDMI two.")).toBe("switch到hdmitwo");
    expect(characterErrorRate("幫我打開 Netflix", "幫我打開NETFLIX")).toBe(0);
  });

  it("counts substitutions, insertions and deletions over the expected length", () => {
    expect(editDistance([..."kitten"], [..."sitting"])).toBe(3);
    expect(characterErrorRate("打開電視", "打開電是")).toBeCloseTo(0.25);
    expect(characterErrorRate("打開電視", "")).toBe(1);
    expect(characterErrorRate("", "")).toBe(0);
    expect(characterErrorRate("", "x")).toBe(1);
  });
});

describe("runBenchmark", () => {
  it("transcribes each item and records what was expected next to what was heard", async () => {
    const results = await runBenchmark({
      engine: fakeStt({ finals: ["打開電視", "音量調到二十"] }),
      items: [item("zh-001", "打開電視"), item("zh-002", "音量調到二十一")],
    });
    expect(results.map((r) => [r.id, r.status, r.actual, r.cer])).toEqual([
      ["zh-001", "ok", "打開電視", 0],
      ["zh-002", "ok", "音量調到二十", 1 / 7],
    ]);
    expect(results[0]).toMatchObject({ backend: "fake", model: "fake-model", language: "zh", tags: ["power"], audioMs: 1000 });
  });

  it("derives the real-time factor and the final latency from the clock, not from the engine", async () => {
    const frozen = await runBenchmark({
      engine: fakeStt({ finals: ["好"] }), items: [item("a", "好", 1000)], now: () => 0, rssMb: () => 111,
    });
    // With a frozen clock every duration is 0 — the arithmetic must still be well-formed.
    expect(frozen[0]).toMatchObject({ decodeMs: 0, rtf: 0, finalLatencyMs: 0, rssMb: 111 });

    // Three reads: the start, the moment the last audio went in, the final result.
    let reads = 0;
    const stepping = () => (reads++ === 0 ? 0 : reads === 2 ? 300 : 500);
    const r2 = await runBenchmark({ engine: fakeStt({ finals: ["好"] }), items: [item("b", "好", 1000)], now: stepping });
    expect(r2[0]).toMatchObject({ decodeMs: 500, rtf: 0.5, finalLatencyMs: 200 });
  });

  it("in realtime mode never sends audio before it would have been spoken", async () => {
    let t = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); t += ms; };
    await runBenchmark({
      engine: fakeStt({ finals: ["好"] }), items: [item("a", "好", 500)],
      realtime: true, now: () => t, sleep,
    });
    expect(slept).toHaveLength(5);                       // five 100 ms chunks
    expect(slept.reduce((a, b) => a + b, 0)).toBe(500);  // exactly the audio's own length
  });

  it("reports a recording that does not exist yet, instead of failing the run", async () => {
    const results = await runBenchmark({
      engine: fakeStt({ finals: ["好"] }),
      items: [{ id: "x", expected: "好" }, item("y", "好")],
    });
    expect(results.map((r) => r.status)).toEqual(["missing_audio", "ok"]);
    expect(results[0]!.cer).toBeNull();
  });

  it("records an engine failure against its item and carries on", async () => {
    const results = await runBenchmark({
      engine: fakeStt({ finals: ["", "好"], failOnFinish: [0] }),
      items: [item("a", "好"), item("b", "好")],
    });
    expect(results.map((r) => r.status)).toEqual(["error", "ok"]);
    expect(results[0]!.error).toBe("engine crashed");
  });

  it("propagates a model that will not load: there is nothing to benchmark", async () => {
    await expect(runBenchmark({ engine: fakeStt({ finals: [], failOnLoad: true }), items: [item("a", "好")] })).rejects.toThrow("model not found");
  });

  it("closes the engine when it is done", async () => {
    const engine = fakeStt({ finals: ["好"] });
    await runBenchmark({ engine, items: [item("a", "好")] });
    expect(engine.closed).toBe(true);
  });
});

describe("summarize and toCsv", () => {
  it("summarises only what ran, and says how much did not", async () => {
    const results = await runBenchmark({
      engine: fakeStt({ finals: ["打開電視", "音量"] }),
      items: [item("a", "打開電視"), item("b", "音量調到二十"), { id: "c", expected: "x" }],
    });
    const s = summarize(results);
    expect(s).toMatchObject({ items: 3, ok: 2, missingAudio: 1, errors: 0, exactRate: 0.5, backend: "fake" });
    expect(s.meanCer).toBeCloseTo((0 + 4 / 6) / 2, 3);
  });

  it("has nulls, not zeros, when nothing ran", () => {
    expect(summarize([])).toMatchObject({ items: 0, meanCer: null, exactRate: null, finalLatencyP50Ms: null });
  });

  it("writes CSV with quoting, and an empty cell for a value that does not exist", async () => {
    const results = await runBenchmark({
      engine: fakeStt({ finals: ['say "hi", ok'] }),
      items: [item("a", "x"), { id: "b", expected: "y" }],
    });
    const lines = toCsv(results).trim().split("\n");
    expect(lines[0]).toMatch(/^id,backend,model,language,tags,status,expected,actual,cer,/);
    expect(lines[1]).toContain('"say ""hi"", ok"');
    expect(lines[2]).toContain("missing_audio");
    expect(lines[2]!.split(",").length).toBe(lines[0]!.split(",").length);
  });
});

describe("parseWav", () => {
  const wav = (o: { bits?: number; code?: number; data?: number[]; extra?: boolean } = {}): Uint8Array => {
    const data = Uint8Array.from(o.data ?? [1, 0, 2, 0, 3, 0, 4, 0]);
    const extra = o.extra ? [..."LIST"].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 9, 9, 9, 9]) : [];
    const head = new Uint8Array(36 + extra.length + 8);
    const v = new DataView(head.buffer);
    const put = (at: number, s: string) => [...s].forEach((c, i) => { head[at + i] = c.charCodeAt(0); });
    put(0, "RIFF"); v.setUint32(4, 36 + extra.length + data.length, true); put(8, "WAVE"); put(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, o.code ?? 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16_000, true); v.setUint32(28, 32_000, true); v.setUint16(32, 2, true); v.setUint16(34, o.bits ?? 16, true);
    head.set(extra, 36);
    put(36 + extra.length, "data"); v.setUint32(40 + extra.length, data.length, true);
    const out = new Uint8Array(head.length + data.length);
    out.set(head); out.set(data, head.length);
    return out;
  };

  it("reads a 16-bit mono file, skipping a LIST chunk instead of assuming a 44-byte header", () => {
    const w = parseWav(wav({ extra: true }));
    expect(w.format).toEqual({ sampleRate: 16_000, channels: 1 });
    expect(Array.from(w.pcm)).toEqual([1, 0, 2, 0, 3, 0, 4, 0]);
    expect(w.durationMs).toBeCloseTo(0.25);
  });

  it("refuses what it would have to convert, and says how", () => {
    expect(() => parseWav(wav({ bits: 24 }))).toThrow(/not 16-bit PCM.*sox/);
    expect(() => parseWav(wav({ code: 3 }))).toThrow(/not 16-bit PCM/);
    expect(() => parseWav(new Uint8Array(100))).toThrow(/not a RIFF\/WAVE/);
  });

  it("drops a truncated trailing sample rather than guessing it", () => {
    expect(Array.from(parseWav(wav({ data: [1, 0, 2, 0, 3] })).pcm)).toEqual([1, 0, 2, 0]);
  });
});
