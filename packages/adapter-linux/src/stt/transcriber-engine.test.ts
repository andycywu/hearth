import { describe, expect, it } from "vitest";
import { parseWav } from "@hearthkit/edge-voice";
import { createTranscriberEngine } from "./transcriber-engine.js";
import type { Transcriber } from "../voice.js";

const FORMAT = { sampleRate: 16_000, channels: 1 };
/** `ms` of a steady tone at `level` (0..1) as PCM16. */
const tone = (ms: number, level: number): Uint8Array => {
  const n = Math.round((16_000 * ms) / 1000);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 8) * level * 32767), true);
  return out;
};

function engine(over: { reply?: string; minSpeechMs?: number; minRms?: number; maxSpeechMs?: number } = {}) {
  const uploads: Array<{ wav: Uint8Array; format: unknown }> = [];
  const skips: string[] = [];
  const transcribe: Transcriber = async (wav, format) => { uploads.push({ wav, format }); return over.reply ?? "  turn it down \n"; };
  const e = createTranscriberEngine({ transcribe, format: FORMAT, backend: "openai", model: "whisper-1", onSkip: (r) => skips.push(r), ...over });
  return { e, uploads, skips };
}

describe("a transcriber as a speech engine", () => {
  it("collects the utterance and uploads it once, at its end, as a WAV of exactly what was kept", async () => {
    const { e, uploads } = engine();
    const s = await e.start();
    const parts = [tone(300, 0.2), tone(300, 0.2), tone(200, 0.2)];
    for (const p of parts) expect(await s.push(p)).toEqual([]);          // not streaming: no partials, no upload yet
    expect(uploads).toHaveLength(0);
    const result = await s.finish();
    expect(result).toEqual({ text: "turn it down", isFinal: true, confidence: null });
    expect(uploads).toHaveLength(1);
    const back = parseWav(uploads[0]!.wav);
    expect(back.format).toEqual(FORMAT);
    expect(back.durationMs).toBeCloseTo(800, 0);
    expect(uploads[0]!.format).toEqual({ encoding: "S16_LE", rate: 16_000, channels: 1 });
  });

  it("is a non-streaming engine that says so, so the pipeline insists on a voice detector for it", () => {
    const { e } = engine();
    expect(e).toMatchObject({ streaming: false, backend: "openai", model: "whisper-1" });
  });

  it("sends nothing for a recording too short to be a command, and says it did not", async () => {
    const { e, uploads, skips } = engine();
    const s = await e.start();
    await s.push(tone(150, 0.3));
    expect(await s.finish()).toEqual({ text: "", isFinal: true, confidence: null });
    expect(uploads).toHaveLength(0);
    expect(skips).toEqual(["too-short"]);
  });

  it("sends nothing for a recording that never rose above the room, and says it did not", async () => {
    const { e, uploads, skips } = engine();
    const s = await e.start();
    await s.push(tone(1_000, 0.003));                                    // the Pi's quiet room reads ~0.0035
    expect((await s.finish()).text).toBe("");
    expect(uploads).toHaveLength(0);
    expect(skips).toEqual(["too-quiet"]);
  });

  it("an utterance that does not end is cut at the cap, so a stuck voice detector cannot upload a minute of the room", async () => {
    const { e, uploads } = engine({ maxSpeechMs: 1_000 });
    const s = await e.start();
    for (let i = 0; i < 30; i++) await s.push(tone(100, 0.2));           // three seconds offered
    await s.finish();
    expect(parseWav(uploads[0]!.wav).durationMs).toBeCloseTo(1_000, -2);
  });

  it("abort drops the recording without a request", async () => {
    const { e, uploads } = engine();
    const s = await e.start();
    await s.push(tone(500, 0.3));
    await s.abort();
    expect(uploads).toHaveLength(0);
  });

  it("a transcription failure surfaces as the finish failing, for the pipeline to count", async () => {
    const e = createTranscriberEngine({ transcribe: async () => { throw new Error("transcription failed: 401 Incorrect API key"); }, format: FORMAT });
    const s = await e.start();
    await s.push(tone(500, 0.3));
    await expect(s.finish()).rejects.toThrow(/401/);
  });
});
