import { describe, expect, it } from "vitest";
import { createEdgeListener, gateInput, type RingState, type StatusRing } from "@hearthkit/adapter-linux";
import { createEnergyVad, createPipeline, fakeAudioInput, fakeStt, FORMAT_16K_MONO, pcm, type LogEvent } from "@hearthkit/edge-voice";
import { parseArgs } from "./args.js";
import { createLab } from "./lab.js";
import { runCecTool } from "./lab-run.js";
import { runStt } from "./stt.js";
import { listenForever } from "./voice-loop.js";
import { ringForPipelineEvent } from "./voice-ring.js";

/** A ring that writes down what it was told to show. */
function recordingRing(): StatusRing & { shown: RingState[] } {
  const shown: RingState[] = [];
  return { shown, show: async (s) => { shown.push(s); }, off: async () => { shown.push("off"); } };
}

const loud = (ms: number): Uint8Array => {
  const out = pcm(ms);
  const v = new DataView(out.buffer);
  for (let i = 0; i < out.byteLength / 2; i++) v.setInt16(i * 2, 8000, true);
  return out;
};

describe("the ring and the recogniser", () => {
  it("maps each place work starts or stops to a state, and leaves the rest to others", () => {
    const e = (event: string): LogEvent => ({ event });
    expect(ringForPipelineEvent(e("pipeline_loading"))).toBe("loading");
    expect(ringForPipelineEvent(e("pipeline_started"))).toBe("listening");
    expect(ringForPipelineEvent(e("speech_started"))).toBe("hearing");
    expect(ringForPipelineEvent(e("speech_ended"))).toBe("recognizing");
    expect(ringForPipelineEvent(e("stt_empty"))).toBe("listening");
    expect(ringForPipelineEvent(e("stt_error"))).toBe("failed");
    // A final transcript is handed to the agent, whose own states take over; the pipeline stopping is for whoever stopped it.
    expect(ringForPipelineEvent(e("stt_result"))).toBeUndefined();
    expect(ringForPipelineEvent(e("pipeline_stopped"))).toBeUndefined();
  });

  it("hearth stt moves the ring through loading, ready, hearing and recognising", async () => {
    const ring = recordingRing();
    const audio = [...Array(4)].map(() => pcm(100)).concat([...Array(4)].map(() => loud(100)), [...Array(8)].map(() => pcm(100)));
    await runStt(parseArgs(["stt", "--quiet"], {}), {
      env: {}, io: { out: () => {}, err: () => {} }, ring,
      makeInput: () => fakeAudioInput(audio), makeEngine: async () => fakeStt({ finals: ["好"] }),
    });
    expect(ring.shown).toEqual(["loading", "listening", "hearing", "recognizing"]);
  });

  it("the listening loop shows work while a person speaks, and nothing while the box is talking", async () => {
    // The same wiring createLocalListener does, minus the sherpa process.
    const ring = recordingRing();
    const mic = fakeAudioInput([...Array(2)].map(() => loud(100)).concat([...Array(10)].map(() => pcm(100))));
    const gated = gateInput(mic);
    const pipeline = createPipeline({
      input: gated, stt: fakeStt({ finals: ["turn it down"] }), vad: createEnergyVad({ format: FORMAT_16K_MONO }),
      log: (e) => { const s = ringForPipelineEvent(e); if (s) void ring.show(s); },
    });
    const listener = createEdgeListener({ pipeline, gate: gated });
    const heard = listener.listen();
    expect(await heard).toBe("turn it down");
    expect(ring.shown).toEqual(["loading", "listening", "hearing", "recognizing"]);
    await listener.stop();
  });
});

describe("the ring when the microphone is lost", () => {
  it("blinks the error state — a still blue ring would say it can still hear", async () => {
    const ring = recordingRing();
    const voice = {
      startListening: async () => { throw new Error("arecord stopped capturing"); },
      stopListening: async () => {}, onTranscript: () => () => {}, speak: async () => {},
    };
    listenForever(voice as never, async () => {}, { ring, trace: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(ring.shown).toEqual(["listening", "error"]);
  });
});

describe("the ring and CEC commands", () => {
  const bus = (verdict: "reply" | "none") => async (_cmd: string, args: string[]) => {
    const a = args.slice(2);
    const info = "Driver Info:\n\tPhysical Address           : 3.0.0.0\n\tLogical Address Mask       : 0x0010\n\tLogical Addresses          : 1 (Allow RC Passthrough)\n";
    if (a.length === 0) return { code: 0, stdout: info, stderr: "" };
    if (verdict === "none") return { code: 0, stdout: "Transmit from Playback Device 1 to TV (4 to 0):\n\tTx, Not Acknowledged (4), Max Retries\n", stderr: "" };
    return { code: 0, stdout: `${info}Transmit to TV:\n    Received from TV (0):\n\tpwr-state: on (0x00)\n`, stderr: "" };
  };
  const io = { out: () => {}, err: () => {} };

  it("a one-shot command moves the ring while it runs and shows the answer's colour", async () => {
    const ring = recordingRing();
    await runCecTool(parseArgs(["cec", "tv-power-status"]), ["tv-power-status"], io, { cec: { device: "/dev/cec0", run: bus("reply") }, ring });
    expect(ring.shown).toEqual(["acting", "verified"]);
  });

  it("red when nobody on the bus answered", async () => {
    const ring = recordingRing();
    await runCecTool(parseArgs(["cec", "tv-power-status"]), ["tv-power-status"], io, { cec: { device: "/dev/cec0", run: bus("none") }, ring });
    expect(ring.shown).toEqual(["acting", "failed"]);
  });

  it("the lab does the same for every command it sends, and for the microphone and the speaker", async () => {
    const ring = recordingRing();
    const lab = createLab({
      token: "t", ring, cec: { device: "/dev/cec0", run: bus("reply") }, throttled: async () => "0x0",
      audio: {
        last: () => undefined,
        record: async () => ({ ok: true, levels: { seconds: 1, rms: 0, peak: 0, rmsDb: null, peakDb: null }, cmdline: "arecord" }),
        play: async () => ({ ok: true, cmdline: "aplay" }),
        say: async () => ({ ok: true, cmdline: "espeak-ng" }),
      },
    });
    const port = await lab.listen(0);
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}?t=t`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("/api/run", { id: "tv-power-status" });
    await post("/api/audio/record", { seconds: 2 });
    await post("/api/audio/say", { text: "hello" });
    await lab.close();
    // acting -> the answer; the microphone open -> ready; the speaker -> ready. Still at the end.
    expect(ring.shown).toEqual(["acting", "verified", "hearing", "listening", "speaking", "listening"]);
  });

  it("a ring that cannot be written never fails a CEC command", async () => {
    const broken: StatusRing = { show: async () => { throw new Error("spidev: busy"); }, off: async () => {} };
    const out: string[] = [];
    const code = await runCecTool(parseArgs(["cec", "tv-power-status"]), ["tv-power-status"], { out: (t) => { out.push(t); }, err: () => {} }, {
      cec: { device: "/dev/cec0", run: bus("reply") }, ring: broken,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("pwr-state: on");
  });
});
