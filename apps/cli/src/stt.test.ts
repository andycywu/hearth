import { describe, expect, it } from "vitest";
import { fakeAudioInput, fakeStt, pcm } from "@hearthkit/edge-voice";
import { parseArgs } from "./args.js";
import { runStt } from "./stt.js";

const loud = (ms: number): Uint8Array => {
  const out = pcm(ms);
  const v = new DataView(out.buffer);
  for (let i = 0; i < out.byteLength / 2; i++) v.setInt16(i * 2, 8000, true);
  return out;
};
const room = (ms: number) => pcm(ms);

/** 400 ms of room, 400 ms of speech, 800 ms of room: one utterance for the energy VAD. */
const oneUtterance = () => [...Array(4)].map(() => room(100)).concat([...Array(4)].map(() => loud(100)), [...Array(8)].map(() => room(100)));

function harness(env: Record<string, string>, over: Partial<Parameters<typeof runStt>[1]> = {}) {
  const out: string[] = []; const err: string[] = [];
  const opts = parseArgs(["stt", ...(env.JSON ? ["--json"] : [])], {});
  const deps = {
    env, io: { out: (t: string) => { out.push(t); }, err: (t: string) => { err.push(t); } },
    makeInput: () => fakeAudioInput(oneUtterance()),
    makeEngine: async () => fakeStt({ finals: ["音量調到二十"], partials: ["音量"] }),
    rssMb: () => 120,
    ...over,
  };
  return { out, err, run: () => runStt(opts, deps) };
}

describe("hearth stt", () => {
  it("is parsed as a subcommand, and takes no commands", () => {
    expect(parseArgs(["stt"]).stt).toBe(true);
    expect(parseArgs(["stt", "hello"]).errors[0]).toMatch(/^stt takes no commands \(got: hello\)/);
    expect(parseArgs(["stt the volume"]).stt).toBe(false);          // a sentence, not the subcommand
  });

  it("prints each final transcript on stdout and the metrics as JSON on stderr", async () => {
    const h = harness({});
    expect(await h.run()).toBe(0);
    expect(h.out).toEqual(["音量調到二十\n"]);
    const logged = h.err.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged.find((e) => e.event === "stt_result")).toMatchObject({
      backend: "fake", text: "音量調到二十", rss_mb: 120,
    });
  });

  it("emits the normalized Transcript with --json", async () => {
    const h = harness({ JSON: "1" });
    await h.run();
    expect(JSON.parse(h.out[0]!)).toMatchObject({ text: "音量調到二十", isFinal: true, confidence: null, backend: "fake" });
  });

  it("tells the truth about the two switches this build does not have", async () => {
    const h = harness({ HEARTH_WAKE_WORD_ENABLED: "true", HEARTH_AUDIO_PREPROCESSING_ENABLED: "1" });
    await h.run();
    const said = h.err.join("");
    expect(said).toContain("no wake-word detector yet");
    expect(said).toContain("no AEC/NS/AGC backend exists yet");
  });

  it("names a backend it cannot build instead of falling back to another", async () => {
    const h = harness({ HEARTH_STT_BACKEND: "whisper" }, { makeEngine: undefined });
    expect(await h.run()).toBe(2);
    expect(h.err.join("")).toMatch(/HEARTH_STT_BACKEND=whisper: this build has only sherpa/);
    expect(h.out).toEqual([]);
  });

  it("says which settings are missing when no model is configured", async () => {
    const h = harness({}, { makeEngine: undefined });
    expect(await h.run()).toBe(2);
    expect(h.err.join("")).toMatch(/HEARTH_STT_MODEL_PATH.*HEARTH_STT_RUNTIME_PATH.*HEARTH_STT_SERVER_URL/);
  });

  it("exits 1 and says why when the microphone fails", async () => {
    const h = harness({}, { makeInput: () => fakeAudioInput(oneUtterance(), { failAfter: 2 }) });
    expect(await h.run()).toBe(1);
    expect(h.err.join("")).toContain("audio device disconnected");
  });

  it("exits 1 when the model cannot load", async () => {
    const h = harness({}, { makeEngine: async () => fakeStt({ finals: [], failOnLoad: true }) });
    expect(await h.run()).toBe(1);
    expect(h.err.join("")).toContain("model not found");
  });

  it("--quiet silences the metrics but not the transcripts", async () => {
    const out: string[] = []; const err: string[] = [];
    const opts = parseArgs(["stt", "--quiet"], {});
    await runStt(opts, {
      env: {}, io: { out: (t) => { out.push(t); }, err: (t) => { err.push(t); } },
      makeInput: () => fakeAudioInput(oneUtterance()), makeEngine: async () => fakeStt({ finals: ["好"] }),
    });
    expect(out).toEqual(["好\n"]);
    expect(err).toEqual([]);
  });
});
