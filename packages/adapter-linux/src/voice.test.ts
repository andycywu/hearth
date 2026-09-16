import { describe, it, expect, vi } from "vitest";
import { isTvUnsupported } from "@hearthkit/platform-api";
import {
  createLinuxVoicePipeline, createOpenAiTranscriber, detectVoice, type Transcriber,
} from "./voice.js";
import type { Runner } from "./run.js";

/** A runner that answers per command name, and records what was asked of it. */
function fakeRunner(
  answers: Record<string, { code?: number; stdout?: string; stderr?: string }> = {},
): Runner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    const a = answers[cmd] ?? {};
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  }) as Runner & { calls: string[] };
  run.calls = calls;
  return run;
}

const ok = { arecord: { stdout: "" }, "espeak-ng": { stdout: "" } };
const readCapture = async () => new Uint8Array([1, 2, 3, 4]);

describe("detectVoice", () => {
  it("reads a capture card from arecord's list, not from its exit code", async () => {
    // `arecord -l` exits 0 and prints only a header when the machine has no
    // capture device at all. Believing the exit code reported a microphone on a
    // Raspberry Pi that had none — twice, because the first check was mine.
    const empty = fakeRunner({ arecord: { stdout: "**** List of CAPTURE Hardware Devices ****\n" } });
    expect(await detectVoice(empty)).toEqual({ capture: false, tts: true });

    const real = fakeRunner({
      arecord: {
        stdout: "**** List of CAPTURE Hardware Devices ****\n"
          + "card 1: seeed4micvoicec [seeed-4mic-voicecard], device 0: bcm2835-i2s-ac10x-codec0\n",
      },
    });
    expect(await detectVoice(real)).toEqual({ capture: true, tts: true });
  });

  it("answers the two halves separately", async () => {
    // A microphone HAT and no espeak-ng is a box that can hear and not answer.
    const mute = fakeRunner({
      arecord: { stdout: "card 1: seeed4micvoicec [seeed-4mic-voicecard]\n" },
      "espeak-ng": { code: 127, stderr: "not found" },
    });
    expect(await detectVoice(mute)).toEqual({ capture: true, tts: false });
  });
});

describe("the Linux voice pipeline", () => {
  it("refuses to listen when nothing can turn audio into text", async () => {
    const voice = createLinuxVoicePipeline({ run: fakeRunner(ok), readCapture });
    // `unsupported`, not a silent recording. A microphone this build cannot
    // understand is a capability it does not have.
    await expect(voice.startListening()).rejects.toSatisfy(isTvUnsupported);
  });

  it("records with the format it was configured for, then transcribes it", async () => {
    const run = fakeRunner(ok);
    const transcribe = vi.fn<Transcriber>(async () => "  turn it down  ");
    const voice = createLinuxVoicePipeline({
      run, readCapture, transcribe, device: "ac108", seconds: 3, channels: 4, rate: 16_000,
    });

    const heard: string[] = [];
    voice.onTranscript((text, isFinal) => { if (isFinal) heard.push(text); });
    await voice.startListening();

    expect(run.calls[0]).toBe("arecord -D ac108 -f S16_LE -r 16000 -c 4 -d 3 /tmp/hearth-capture.wav");
    expect(transcribe).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3, 4]),
      { encoding: "S16_LE", rate: 16_000, channels: 4 },
    );
    expect(heard).toEqual(["turn it down"]);
  });

  it("ends the attempt even when nothing was said", async () => {
    // The failure this exists to prevent: the microphone closes, no transcript
    // arrives, and the caller listens forever to a device that already stopped.
    const voice = createLinuxVoicePipeline({
      run: fakeRunner(ok), readCapture, transcribe: async () => "",
    });
    const ended = vi.fn();
    voice.onListeningEnd!(ended);
    await voice.startListening();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("ends the attempt when transcription throws", async () => {
    const voice = createLinuxVoicePipeline({
      run: fakeRunner(ok), readCapture,
      transcribe: async () => { throw new Error("endpoint down"); },
    });
    const ended = vi.fn();
    voice.onListeningEnd!(ended);
    await expect(voice.startListening()).rejects.toThrow(/endpoint down/);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("delivers nothing after stopListening, and says that is what stop means", async () => {
    // `arecord` is run to completion through the Runner, which hands back no
    // process to kill — so stop cannot cut the microphone off mid-word. What it
    // guarantees is that nothing arrives afterwards, and a caller that pressed
    // stop and then got a transcript would have been right to call that a bug.
    const run = fakeRunner(ok);
    const voice = createLinuxVoicePipeline({
      run, readCapture, transcribe: async () => "too late",
    });
    const heard: string[] = [];
    voice.onTranscript((t) => heard.push(t));

    const listening = voice.startListening();
    await voice.stopListening();
    await listening;

    expect(heard).toEqual([]);
  });

  it("reports a capture device it cannot open as unsupported", async () => {
    const run = fakeRunner({ arecord: { code: 1, stderr: "audio open error: No such device" } });
    const voice = createLinuxVoicePipeline({
      run, readCapture, transcribe: async () => "never", device: "seeedvoicecard",
    });
    // The name that cost twenty minutes on a real Pi: ALSA truncates a card name
    // to 15 characters, so `seeed-4mic-voicecard` is `seeed4micvoicec`.
    await expect(voice.startListening()).rejects.toThrow(/seeedvoicecard.*No such device/s);
    await expect(voice.startListening()).rejects.toSatisfy(isTvUnsupported);
  });

  it("speaks through espeak-ng, and passes the text after `--`", async () => {
    const run = fakeRunner(ok);
    const voice = createLinuxVoicePipeline({ run, readCapture, voiceName: "cmn" });
    await voice.speak("音量調到 30");
    // `--` so a reply that starts with a dash is spoken rather than parsed as a
    // flag. The text comes from a model; it is not a trusted argument.
    expect(run.calls).toContain("espeak-ng -v cmn -- 音量調到 30");
  });

  it("says nothing rather than running espeak-ng for empty text", async () => {
    const run = fakeRunner(ok);
    const voice = createLinuxVoicePipeline({ run, readCapture });
    await voice.speak("   ");
    expect(run.calls).toEqual([]);
  });

  it("reports a missing espeak-ng as unsupported", async () => {
    const run = fakeRunner({ "espeak-ng": { code: 127, stderr: "command not found" } });
    const voice = createLinuxVoicePipeline({ run, readCapture });
    await expect(voice.speak("hello")).rejects.toSatisfy(isTvUnsupported);
  });
});

describe("the OpenAI-schema transcriber", () => {
  it("posts the audio and returns the text", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "open netflix" }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const transcribe = createOpenAiTranscriber({ baseUrl: "http://pi.local:9000/v1/", fetchImpl });
    const text = await transcribe(new Uint8Array([0]), { encoding: "S16_LE", rate: 16_000, channels: 1 });

    expect(text).toBe("open netflix");
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("http://pi.local:9000/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
  });

  it("treats a 200 with no text field as a failure, not as silence", async () => {
    // Silence and a broken endpoint must not arrive as the same answer: one is
    // "nobody spoke" and the other is "we cannot hear", and a planner that
    // confuses them will keep asking a question nothing can answer.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const transcribe = createOpenAiTranscriber({ baseUrl: "http://x/v1", fetchImpl });
    await expect(transcribe(new Uint8Array([0]), { encoding: "S16_LE", rate: 16_000, channels: 1 }))
      .rejects.toThrow(/no text field/);
  });

  it("carries the endpoint's own complaint when it refuses", async () => {
    const fetchImpl = vi.fn(async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
    const transcribe = createOpenAiTranscriber({ baseUrl: "http://x/v1", fetchImpl });
    await expect(transcribe(new Uint8Array([0]), { encoding: "S16_LE", rate: 16_000, channels: 1 }))
      .rejects.toThrow(/404.*model not found/s);
  });
});
