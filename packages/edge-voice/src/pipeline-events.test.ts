import { describe, expect, it } from "vitest";
import { createPipeline } from "./pipeline.js";
import { fakeAudioInput, fakeStt, fakeVad, pcm } from "./fakes.js";
import type { LogEvent } from "./types.js";

/**
 * The places work starts and stops, as events — because a status light has no other way to know the
 * model is loading, a voice is being heard, or the words are being worked out.
 */
describe("pipeline activity events", () => {
  it("says loading begins, then started, then each speech's start and end, in order", async () => {
    const log: LogEvent[] = [];
    const vad = fakeVad({
      1: [{ type: "speech_started", atMs: 100 }, { type: "speech_chunk", chunk: pcm(100), atMs: 100 }],
      4: [{ type: "speech_ended", atMs: 400 }],
    });
    const p = createPipeline({
      input: fakeAudioInput(Array.from({ length: 6 }, () => pcm(100))), stt: fakeStt({ finals: ["好"] }), vad, log: (e) => log.push(e),
    });
    await p.run();
    expect(log.map((e) => e.event)).toEqual([
      "pipeline_loading", "pipeline_started", "speech_started", "speech_ended", "stt_result", "pipeline_stopped",
    ]);
  });

  it("announces loading before the load, so something can show the wait", async () => {
    const order: string[] = [];
    const stt = fakeStt({ finals: [] });
    const realLoad = stt.load.bind(stt);
    stt.load = async () => { order.push("load"); await realLoad(); };
    const p = createPipeline({ input: fakeAudioInput([]), stt, vad: fakeVad({}), log: (e) => order.push(e.event) });
    await p.run();
    expect(order.slice(0, 3)).toEqual(["pipeline_loading", "load", "pipeline_started"]);
  });
});
