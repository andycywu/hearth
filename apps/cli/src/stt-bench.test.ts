import { describe, expect, it } from "vitest";
import { fakeStt } from "@hearthkit/edge-voice";
import { parseArgs } from "./args.js";
import { runStt } from "./stt.js";

/** A 16 kHz mono PCM16 WAV of `ms` of silence. */
function wav(ms: number, rate = 16_000, channels = 1): Uint8Array {
  const data = new Uint8Array(Math.round((rate * channels * 2 * ms) / 1000));
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

const MANIFEST = {
  name: "tv-commands",
  items: [
    { id: "zh-001", audio: "recordings/zh-001.wav", expected: "打開電視", language: "zh", tags: ["power"] },
    { id: "zh-002", audio: "recordings/zh-002.wav", expected: "音量調到二十", language: "zh" },
    { id: "en-001", audio: "recordings/en-001.wav", expected: "Turn on the TV", language: "en" },
  ],
};

function files(map: Record<string, Uint8Array | string>) {
  return async (path: string): Promise<Uint8Array> => {
    const key = path.replace(/\\/g, "/").replace(/^.*?(?=manifest\.json|recordings\/)/, "");
    const hit = map[key];
    if (hit === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return typeof hit === "string" ? new TextEncoder().encode(hit) : hit;
  };
}

function run(argv: string[], map: Record<string, Uint8Array | string>, finals: string[], extra: Record<string, string> = {}) {
  const out: string[] = []; const err: string[] = []; const written: Record<string, string> = {};
  const opts = parseArgs(argv, {});
  const code = runStt(opts, {
    env: extra,
    io: { out: (t) => { out.push(t); }, err: (t) => { err.push(t); } },
    makeEngine: async () => fakeStt({ finals }),
    readFile: files(map), writeFile: async (p, d) => { written[p.replace(/\\/g, "/")] = d; },
    rssMb: () => 100,
  });
  return { code, out, err, written };
}

describe("hearth stt bench", () => {
  it("is parsed with its manifest, and complains without one", () => {
    expect(parseArgs(["stt", "bench", "m.json", "--realtime"])).toMatchObject({ stt: true, sttBench: "m.json", realtime: true });
    expect(parseArgs(["stt", "bench"]).errors[0]).toMatch(/needs a manifest/);
  });

  it("runs each recording through the engine and reports expected against actual", async () => {
    const h = run(["stt", "bench", "bench/manifest.json", "--quiet"], {
      "manifest.json": JSON.stringify(MANIFEST), "recordings/zh-001.wav": wav(1000), "recordings/zh-002.wav": wav(1500), "recordings/en-001.wav": wav(800),
    }, ["打開電視", "音量調到二十一", "turn on the tv"]);
    expect(await h.code).toBe(0);
    const report = JSON.parse(h.out.join("")) as { mode: string; summary: Record<string, unknown>; results: Array<Record<string, unknown>> };
    expect(report.mode).toBe("fast");
    expect(report.results.map((r) => [r.id, r.status, r.actual, Number((r.cer as number).toFixed(3))])).toEqual([
      ["zh-001", "ok", "打開電視", 0],
      ["zh-002", "ok", "音量調到二十一", 0.167],     // one inserted character in six
      ["en-001", "ok", "turn on the tv", 0],
    ]);
    expect(report.summary).toMatchObject({ items: 3, ok: 3, exactRate: 0.6667, backend: "fake" });
  });

  it("reports a recording not made yet as missing, and still exits 0", async () => {
    const h = run(["stt", "bench", "bench/manifest.json", "--quiet"], {
      "manifest.json": JSON.stringify(MANIFEST), "recordings/zh-001.wav": wav(1000),
    }, ["打開電視"]);
    expect(await h.code).toBe(0);
    const report = JSON.parse(h.out.join("")) as { summary: { missingAudio: number; ok: number } };
    expect(report.summary).toMatchObject({ ok: 1, missingAudio: 2 });
  });

  it("refuses a recording in the wrong format rather than resampling it, and exits 1", async () => {
    const h = run(["stt", "bench", "bench/manifest.json", "--quiet"], {
      "manifest.json": JSON.stringify(MANIFEST), "recordings/zh-001.wav": wav(1000, 44_100, 2),
    }, ["x"]);
    expect(await h.code).toBe(1);
    const report = JSON.parse(h.out.join("")) as { results: Array<{ status: string; error: string }> };
    expect(report.results[0]).toMatchObject({ status: "error" });
    expect(report.results[0]!.error).toMatch(/44100 Hz × 2ch.*does not resample/);
  });

  it("writes JSON and CSV next to each other with --out", async () => {
    const h = run(["stt", "bench", "bench/manifest.json", "--quiet", "--out", "run1"], {
      "manifest.json": JSON.stringify(MANIFEST), "recordings/zh-001.wav": wav(1000),
    }, ["打開電視"]);
    await h.code;
    expect(Object.keys(h.written)).toEqual(["run1.json", "run1.csv"]);
    expect(h.written["run1.csv"]!.split("\n")[0]).toMatch(/^id,backend,model/);
  });

  it("rejects a malformed manifest with the item that is wrong", async () => {
    const bad = run(["stt", "bench", "bench/manifest.json"], { "manifest.json": JSON.stringify({ items: [{ id: "a" }] }) }, []);
    expect(await bad.code).toBe(2);
    expect(bad.err.join("")).toMatch(/item 0 needs string "id", "audio" and "expected"/);

    const dup = run(["stt", "bench", "bench/manifest.json"], {
      "manifest.json": JSON.stringify({ items: [{ id: "a", audio: "x.wav", expected: "x" }, { id: "a", audio: "y.wav", expected: "y" }] }),
    }, []);
    expect(await dup.code).toBe(2);
    expect(dup.err.join("")).toMatch(/duplicate id "a"/);

    const missing = run(["stt", "bench", "nope/manifest.json"], {}, []);
    expect(await missing.code).toBe(2);
    expect(missing.err.join("")).toMatch(/cannot read manifest/);
  });
});

describe("the committed dataset manifest", () => {
  it("is well-formed: unique ids, known languages, and no audio in the repository", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const path = resolve(__dirname, "../../../bench/stt/tv-commands.json");
    const { loadBenchItems } = await import("./stt-bench.js");
    const { resolveEdgeVoiceConfig } = await import("@hearthkit/edge-voice");
    const items = await loadBenchItems(path, resolveEdgeVoiceConfig({}).config, async (p) => new Uint8Array(await readFile(p)));
    expect(items.length).toBeGreaterThanOrEqual(15);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.every((i) => ["zh", "en", "mixed"].includes(i.language ?? ""))).toBe(true);
    // Recordings are not committed (see bench/stt/README.md): until someone makes them, every item is missing.
    expect(items.every((i) => i.audio === undefined && i.error === undefined)).toBe(true);
  });
});
