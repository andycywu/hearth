import { describe, expect, it } from "vitest";
import {
  createEnergyVad, createPipeline, fakeStt, FORMAT_16K_MONO, pcm, type AudioInput,
} from "@hearthkit/edge-voice";
import { createEdgeListener, gateInput } from "./listener.js";
import { createLinuxVoicePipeline } from "../voice.js";

/** A microphone the test speaks into: chunks are pushed when the test says so. */
function liveMic(): AudioInput & { push(c: Uint8Array): void; end(): void; fail(e: Error): void } {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  const poke = () => { wake?.(); wake = undefined; };
  return {
    format: FORMAT_16K_MONO,
    push(c) { queue.push(c); poke(); },
    end() { ended = true; poke(); },
    fail(e) { failure = e; poke(); },
    open() {
      return (async function* () {
        for (;;) {
          if (failure) throw failure;
          const next = queue.shift();
          if (next) { yield next; continue; }
          if (ended) return;
          await new Promise<void>((r) => { wake = r; });
        }
      })();
    },
    async close() { ended = true; poke(); },
  };
}

const loud = (ms: number): Uint8Array => {
  const out = pcm(ms);
  const v = new DataView(out.buffer);
  for (let i = 0; i < out.byteLength / 2; i++) v.setInt16(i * 2, 8000, true);
  return out;
};
const quiet = (ms: number) => pcm(ms);
const settle = () => new Promise((r) => setTimeout(r, 10));

/** 400 ms of speech followed by 800 ms of room: one utterance for the energy VAD. */
async function say(mic: ReturnType<typeof liveMic>): Promise<void> {
  for (let i = 0; i < 4; i++) { mic.push(loud(100)); await settle(); }
  for (let i = 0; i < 8; i++) { mic.push(quiet(100)); await settle(); }
}

function rig(finals: string[], opts: { failOnLoad?: boolean } = {}) {
  const mic = liveMic();
  const gated = gateInput(mic);
  const stt = fakeStt({ finals, ...opts });
  const pipeline = createPipeline({ input: gated, stt, vad: createEnergyVad({ format: FORMAT_16K_MONO }) });
  const listener = createEdgeListener({ pipeline, gate: gated });
  return { mic, stt, listener };
}

describe("edge listener: one utterance at a time, on a pipeline that stays up", () => {
  it("returns the next final transcript", async () => {
    const r = rig(["turn it down"]);
    const heard = r.listener.listen();
    await settle();
    await say(r.mic);
    expect(await heard).toBe("turn it down");
    await r.listener.stop();
  });

  it("drops audio nobody is listening for — the agent's own reply never reaches the recogniser", async () => {
    const r = rig(["first", "second"]);
    const one = r.listener.listen();
    await settle();
    await say(r.mic);
    expect(await one).toBe("first");

    await say(r.mic);                              // spoken between listens: the box talking, or the room
    expect(r.stt.starts).toBe(1);                  // no second session was opened for it

    const two = r.listener.listen();
    await settle();
    await say(r.mic);
    expect(await two).toBe("second");
    expect(r.stt.starts).toBe(2);
    await r.listener.stop();
  });

  it("loads the model once, however many times it listens", async () => {
    const r = rig(["a", "b"]);
    for (const expected of ["a", "b"]) {
      const heard = r.listener.listen();
      await settle();
      await say(r.mic);
      expect(await heard).toBe(expected);
    }
    expect(r.stt.loaded).toBe(true);
    expect(r.stt.closed).toBe(false);
    await r.listener.stop();
    expect(r.stt.closed).toBe(true);
  });

  it("cancel() resolves a pending listen with nothing, and it can listen again", async () => {
    const r = rig(["after"]);
    const pending = r.listener.listen();
    await settle();
    r.listener.cancel();
    expect(await pending).toBe("");

    const again = r.listener.listen();
    await settle();
    await say(r.mic);
    expect(await again).toBe("after");
    await r.listener.stop();
  });

  it("rejects a pending listen when the microphone fails, and every listen after it", async () => {
    const r = rig(["x"]);
    const pending = r.listener.listen();
    await settle();
    r.mic.fail(new Error("arecord stopped capturing from \"default\": busy"));
    await expect(pending).rejects.toThrow(/arecord stopped capturing/);
    await expect(r.listener.listen()).rejects.toThrow(/arecord stopped capturing/);
  });

  it("rejects when the model will not load", async () => {
    const r = rig(["x"], { failOnLoad: true });
    await expect(r.listener.listen()).rejects.toThrow("model not found");
  });
});

describe("the Linux voice pipeline with a listener", () => {
  const noTool = async () => { throw new Error("arecord must not run when a listener is given"); };

  it("delivers what the listener heard as a final transcript, and reports the attempt over", async () => {
    const seen: Array<[string, boolean]> = [];
    let ended = 0;
    const voice = createLinuxVoicePipeline({ run: noTool as never, listener: { listen: async () => " turn it down ", cancel() {} } });
    voice.onTranscript((t, f) => seen.push([t, f]));
    voice.onListeningEnd?.(() => { ended++; });
    await voice.startListening();
    expect(seen).toEqual([["turn it down", true]]);
    expect(ended).toBe(1);
  });

  it("says nothing for a listener that heard nothing", async () => {
    const seen: string[] = [];
    const voice = createLinuxVoicePipeline({ run: noTool as never, listener: { listen: async () => "", cancel() {} } });
    voice.onTranscript((t) => seen.push(t));
    await voice.startListening();
    expect(seen).toEqual([]);
  });

  it("throws what the listener threw, so the voice loop can say why it stopped", async () => {
    const voice = createLinuxVoicePipeline({ run: noTool as never, listener: { listen: async () => { throw new Error("model not found"); }, cancel() {} } });
    await expect(voice.startListening()).rejects.toThrow("model not found");
  });

  it("stopListening cancels the listener and nothing arrives afterwards", async () => {
    let release: (t: string) => void = () => {};
    let cancelled = 0;
    const listener = { listen: () => new Promise<string>((r) => { release = r; }), cancel() { cancelled++; release(""); } };
    const seen: string[] = [];
    const voice = createLinuxVoicePipeline({ run: noTool as never, listener });
    voice.onTranscript((t) => seen.push(t));
    const attempt = voice.startListening();
    await voice.stopListening();
    await attempt;
    expect(cancelled).toBe(1);
    expect(seen).toEqual([]);
  });
});
