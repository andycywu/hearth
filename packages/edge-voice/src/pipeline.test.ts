import { describe, expect, it } from "vitest";
import { createPipeline } from "./pipeline.js";
import { fakeAudioInput, fakeStt, fakeVad, fakeWake, pcm } from "./fakes.js";
import type { LogEvent, Transcript, VadEvent } from "./types.js";

const hundredMs = (n: number) => Array.from({ length: n }, () => pcm(100));
const speech = (from: number, to: number): Record<number, VadEvent[]> => ({
  [from]: [{ type: "speech_started", atMs: from * 100 }, { type: "speech_chunk", chunk: pcm(100), atMs: from * 100 }],
  [from + 1]: [{ type: "speech_chunk", chunk: pcm(100), atMs: (from + 1) * 100 }],
  [to]: [{ type: "speech_ended", atMs: to * 100 }],
});

function collect(p: ReturnType<typeof createPipeline>): Transcript[] {
  const out: Transcript[] = [];
  p.onTranscript((t) => out.push(t));
  return out;
}

describe("pipeline: microphone → VAD → STT → Transcript", () => {
  it("emits one final transcript per utterance, positioned in the audio stream", async () => {
    const stt = fakeStt({ finals: ["打開電視"], language: "zh" });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(6)), stt, vad: fakeVad(speech(1, 4)) });
    const got = collect(p);
    await p.run();
    expect(got).toEqual([{
      text: "打開電視", language: "zh", isFinal: true, confidence: null,
      startTimeMs: 100, endTimeMs: 400, backend: "fake",
    }]);
  });

  it("never invents a confidence", async () => {
    const p = createPipeline({ input: fakeAudioInput(hundredMs(6)), stt: fakeStt({ finals: ["x"] }), vad: fakeVad(speech(1, 4)) });
    const got = collect(p);
    await p.run();
    expect(got.every((t) => t.confidence === null)).toBe(true);
  });

  it("passes partials through as non-final, then the final", async () => {
    const stt = fakeStt({ finals: ["turn on the tv"], partials: ["turn", "turn on"] });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(6)), stt, vad: fakeVad(speech(1, 4)) });
    const got = collect(p);
    await p.run();
    expect(got.map((t) => [t.text, t.isFinal])).toEqual([["turn", false], ["turn on", false], ["turn on the tv", true]]);
  });

  it("logs the utterance with its latency and the backend", async () => {
    let wall = 1_000;
    const log: LogEvent[] = [];
    const stt = fakeStt({ finals: ["音量調到二十"], language: "zh" });
    // Each `now()` call advances the clock 50 ms: speech_ended is read, then the result.
    const now = () => (wall += 50);
    const p = createPipeline({
      input: fakeAudioInput(hundredMs(6)), stt, vad: fakeVad(speech(1, 4)),
      now, rssMb: () => 146, log: (e) => log.push(e),
    });
    await p.run();
    const result = log.find((e) => e.event === "stt_result");
    expect(result).toMatchObject({
      backend: "fake", text: "音量調到二十", language: "zh",
      audio_duration_ms: 300, stt_latency_ms: 50, rss_mb: 146,
    });
  });

  it("drops an utterance that recognised nothing instead of emitting an empty transcript", async () => {
    const log: LogEvent[] = [];
    const p = createPipeline({ input: fakeAudioInput(hundredMs(6)), stt: fakeStt({ finals: [""] }), vad: fakeVad(speech(1, 4)), log: (e) => log.push(e) });
    const got = collect(p);
    await p.run();
    expect(got).toEqual([]);
    expect(log.some((e) => e.event === "stt_empty")).toBe(true);
  });
});

describe("pipeline: wake word", () => {
  it("keeps STT idle until the detector fires", async () => {
    const stt = fakeStt({ finals: ["x"] });
    const wake = fakeWake(99);                       // never fires
    const p = createPipeline({ input: fakeAudioInput(hundredMs(6)), stt, vad: fakeVad(speech(1, 4)), wake });
    await p.run();
    expect(stt.starts).toBe(0);
    expect(wake.seen).toBe(6);
  });

  it("recognises an utterance only after the wake word, and needs the word again for the next one", async () => {
    const stt = fakeStt({ finals: ["first", "second"] });
    // Wake on chunk 0; the VAD sees chunks from 1 on, and is scripted by its own count.
    const vad = fakeVad({
      0: [{ type: "speech_started", atMs: 100 }, { type: "speech_chunk", chunk: pcm(100), atMs: 100 }],
      2: [{ type: "speech_ended", atMs: 300 }],
      3: [{ type: "speech_started", atMs: 400 }],      // no wake word before this one
      4: [{ type: "speech_ended", atMs: 500 }],
    });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(6)), stt, vad, wake: fakeWake(0) });
    const got = collect(p);
    await p.run();
    expect(got.map((t) => t.text)).toEqual(["first"]);
    expect(stt.starts).toBe(1);
  });
});

describe("pipeline: a wake word that answers late", () => {
  /** A VAD that records exactly which chunks it was given, in order. */
  const recordingVad = (seen: Uint8Array[]) => ({
    name: "recording-vad",
    accept: (chunk: Uint8Array) => { seen.push(chunk); return []; },
    reset: () => {},
  });

  it("replays the audio spoken while it was deciding, then carries on — so the command is not clipped to its last words", async () => {
    const chunks = hundredMs(6);
    const seen: Uint8Array[] = [];
    const wake = fakeWake(3, { preRollMs: 200 });                 // fires on the fourth chunk, asks for 200 ms before it
    const p = createPipeline({ input: fakeAudioInput(chunks), stt: fakeStt({ finals: [] }), vad: recordingVad(seen), wake });
    await p.run();
    // The two chunks before the one it fired on, the firing chunk itself, then the rest of the stream.
    expect(seen).toEqual([chunks[1], chunks[2], chunks[3], chunks[4], chunks[5]]);
    expect(seen[0]).toBe(chunks[1]);
  });

  it("without a pre-roll the audio resumes after the word, as it always did", async () => {
    const chunks = hundredMs(6);
    const seen: Uint8Array[] = [];
    const p = createPipeline({ input: fakeAudioInput(chunks), stt: fakeStt({ finals: [] }), vad: recordingVad(seen), wake: fakeWake(3) });
    await p.run();
    expect(seen).toEqual([chunks[4], chunks[5]]);
  });

  it("holds only as much audio as it was asked to, not the whole stream", async () => {
    const chunks = hundredMs(40);
    const seen: Uint8Array[] = [];
    const p = createPipeline({ input: fakeAudioInput(chunks), stt: fakeStt({ finals: [] }), vad: recordingVad(seen), wake: fakeWake(30, { preRollMs: 300 }) });
    await p.run();
    expect(seen.length).toBe(3 + 1 + 9);                          // 300 ms before, the firing chunk, nine more
  });

  it("loads the detector before the first chunk and closes it when the pipeline ends, even on a failure", async () => {
    const wake = fakeWake(99);
    const stt = fakeStt({ finals: [] });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(2), { failAfter: 1 }), stt, vad: fakeVad({}), wake });
    await expect(p.run()).rejects.toThrow(/disconnected/);
    expect(wake.order).toEqual(["wake.load", "wake.close"]);
    expect(stt.loaded && stt.closed).toBe(true);
  });
});

describe("pipeline: arming without a wake word", () => {
  // After "Yes?" the host is waiting for the answer; making the person say the wake word twice would be absurd.
  it("takes the next utterance when the host arms it, once, and then waits for the wake word again", async () => {
    const stt = fakeStt({ finals: ["answer", "second"] });
    const vad = fakeVad({ ...speech(1, 3), ...speech(4, 6) });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(8)), stt, vad, wake: fakeWake(99) });
    const got = collect(p);
    p.arm();
    await p.run();
    expect(got.map((t) => t.text)).toEqual(["answer"]);          // the second utterance needed a wake word and had none
    expect(stt.starts).toBe(1);
  });

  it("does nothing when there is no wake word: everything is already accepted", async () => {
    const stt = fakeStt({ finals: ["a"] });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(6)), stt, vad: fakeVad(speech(1, 4)) });
    const got = collect(p);
    p.arm();
    await p.run();
    expect(got.map((t) => t.text)).toEqual(["a"]);
  });
});

describe("pipeline: without a VAD", () => {
  it("feeds a streaming engine the raw stream and passes its finals through", async () => {
    const stt = fakeStt({ finals: [], partials: ["he", "hello"] });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(3)), stt });
    const got = collect(p);
    await p.run();
    expect(got.map((t) => t.text)).toEqual(["he", "hello"]);
  });

  it("refuses a non-streaming engine: nothing would tell it where an utterance ends", () => {
    expect(() => createPipeline({ input: fakeAudioInput([]), stt: fakeStt({ finals: [], streaming: false }) }))
      .toThrow(/does not stream and no VAD/);
  });
});

describe("pipeline: failing gracefully", () => {
  it("survives one bad utterance and recognises the next", async () => {
    const log: LogEvent[] = [];
    const stt = fakeStt({ finals: ["", "好"], failOnFinish: [0] });
    const vad = fakeVad({ ...speech(0, 2), ...speech(3, 5) });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(7)), stt, vad, log: (e) => log.push(e) });
    const got = collect(p);
    await p.run();
    expect(got.map((t) => t.text)).toEqual(["好"]);
    expect(log.find((e) => e.event === "stt_error")).toMatchObject({ stage: "finish", error: "engine crashed" });
  });

  it("stops, saying so, when the engine fails repeatedly — and still closes it", async () => {
    const stt = fakeStt({ finals: [], failOnFinish: [0, 1, 2] });
    const vad = fakeVad({ ...speech(0, 1), 2: [{ type: "speech_started", atMs: 200 }], 3: [{ type: "speech_ended", atMs: 300 }], 4: [{ type: "speech_started", atMs: 400 }], 5: [{ type: "speech_ended", atMs: 500 }] });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(8)), stt, vad });
    await expect(p.run()).rejects.toThrow(/failed 3 times in a row/);
    expect(stt.closed).toBe(true);
  });

  it("rejects when the model cannot load, before reading any audio", async () => {
    const input = fakeAudioInput(hundredMs(3));
    const p = createPipeline({ input, stt: fakeStt({ finals: [], failOnLoad: true }), vad: fakeVad({}) });
    await expect(p.run()).rejects.toThrow("model not found");
  });

  it("rejects when the audio device disappears, and closes the engine", async () => {
    const stt = fakeStt({ finals: ["x"] });
    const p = createPipeline({ input: fakeAudioInput(hundredMs(6), { failAfter: 2 }), stt, vad: fakeVad({}) });
    await expect(p.run()).rejects.toThrow("audio device disconnected");
    expect(stt.closed).toBe(true);
  });

  it("closes the input on stop()", async () => {
    const input = fakeAudioInput(hundredMs(3));
    const p = createPipeline({ input, stt: fakeStt({ finals: [] }), vad: fakeVad({}) });
    await p.stop();
    expect(input.closed).toBe(true);
  });
});
