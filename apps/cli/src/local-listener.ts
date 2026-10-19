/**
 * The voice loop's ears, built on the edge pipeline.
 *
 * `listenForever` wants "wait for one utterance"; the edge pipeline is a stream that has to stay up (a speech model takes
 * ~20 s to load; a keyword model ~10 s). This joins the two with a gated microphone — see
 * `adapter-linux/src/stt/listener.ts` for why the gate is what keeps the agent from hearing itself.
 *
 * Two independent choices, which used to be one:
 *
 *  - **Who recognises**: `local` (a model on this box, nothing sent anywhere) or an OpenAI-schema endpoint (hosted or on the LAN).
 *  - **Who decides it was for us**: a **wake-word detector** that runs on this box before anything is recognised, or — the old way —
 *    the transcript, searched for the word afterwards.
 *
 * With a detector the recogniser is only ever given what was said *after* the wake word, so a hosted recogniser is only paid
 * for utterances that were addressed to Hearth: a television, a conversation in the next room and a recogniser's habit of
 * inventing "thanks for watching" for noise never reach it.
 */
import {
  createEnergyVad, createPipeline, resolveEdgeVoiceConfig, type LogEvent, type SpeechToTextEngine, type WakeWordDetector,
} from "@hearthkit/edge-voice";
import {
  createArecordInput, createEdgeListener, createKwsDetector, createOpenAiTranscriber, createTranscriberEngine, createWavFileInput,
  gateInput, type SpeechListener, type StatusRing,
} from "@hearthkit/adapter-linux";
import { defaultEngine } from "./stt.js";
import type { KwsSettings } from "./kws-config.js";
import { ringForPipelineEvent } from "./voice-ring.js";

/** Events that move the ring and have nothing to say in a terminal. */
const QUIET_EVENTS: ReadonlySet<string> = new Set(["stt_partial", "stt_empty", "speech_started", "speech_ended", "pipeline_loading"]);

export interface LocalListener {
  listener: SpeechListener;
  stop(): Promise<void>;
  /** True when a wake-word detector decided each utterance was for us, so the transcript is the command and not searched for the word. */
  addressed: boolean;
  /** Take the next utterance without the wake word (after "Yes?"). A no-op without a detector. */
  arm(): void;
}

export type Recogniser = "local" | { baseUrl: string; model?: string | undefined; apiKey?: string | undefined };

export async function createLocalListener(
  env: Record<string, string | undefined>,
  io: { err(text: string): void },
  opts: {
    quiet: boolean; ring?: StatusRing | undefined;
    /** Default `local`. */
    recogniser?: Recogniser | undefined;
    /** Run this keyword spotter before recognition. Absent: no detector; the pipeline recognises everything the voice detector keeps. */
    kws?: KwsSettings | undefined;
  },
): Promise<LocalListener> {
  const { config, warnings } = resolveEdgeVoiceConfig(env);
  for (const w of warnings) io.err(`hearth: ${w}\n`);
  if (config.wakeWordEnabled) io.err("hearth: HEARTH_WAKE_WORD_ENABLED is set, but it is not what turns the detector on; use --wake-detector kws\n");

  const recogniser = opts.recogniser ?? "local";
  const format = { sampleRate: config.sampleRate, channels: config.channels };
  // Fails here, before the agent starts, if there is no model to listen with.
  const engine: SpeechToTextEngine = recogniser === "local"
    ? await defaultEngine(config)
    : createTranscriberEngine({
        transcribe: createOpenAiTranscriber({
          baseUrl: recogniser.baseUrl,
          ...(recogniser.model ? { model: recogniser.model } : {}),
          ...(recogniser.apiKey ? { apiKey: recogniser.apiKey } : {}),
        }),
        format,
        backend: /^https:\/\/api\.openai\.com\b/.test(recogniser.baseUrl) ? "openai" : "http",
        model: recogniser.model ?? "whisper-1",
        // Held back and said, not sent: this is the line that separates "nothing was heard" from "nothing was uploaded".
        onSkip: (reason, d) => { if (!opts.quiet) io.err(`  🎤 (not sent: ${reason}, ${Math.round(d.ms)} ms, rms ${d.rms.toFixed(4)})\n`); },
      });
  if (recogniser !== "local" && !config.vadEnabled) {
    throw new Error("a hosted recogniser takes a finished recording, so the voice detector has to cut one: HEARTH_VAD_ENABLED must not be false");
  }

  let wake: WakeWordDetector | undefined;
  if (opts.kws) {
    const k = opts.kws;
    wake = createKwsDetector({
      python: k.python, script: k.script, modelDir: k.modelDir, keywords: k.keywords,
      ...(k.threshold !== undefined ? { threshold: k.threshold } : {}), ...(k.score !== undefined ? { score: k.score } : {}),
      ...(k.chunk !== undefined ? { chunk: k.chunk } : {}), ...(k.preRollMs !== undefined ? { preRollMs: k.preRollMs } : {}),
    });
  }

  // `HEARTH_AUDIO_DEVICE=file:/path/to.wav` plays a recording into the whole voice path as if it were the
  // microphone, paced to its own clock: the same speech every time, for testing without anyone in the room.
  const fromFile = config.audioDevice.startsWith("file:");
  const gated = gateInput(fromFile
    ? createWavFileInput({ path: config.audioDevice.slice("file:".length), format })
    : createArecordInput({ device: config.audioDevice, format }));
  if (fromFile) io.err(`hearth: listening to ${config.audioDevice.slice("file:".length)}, not a microphone\n`);
  const pipeline = createPipeline({
    input: gated, stt: engine,
    ...(config.vadEnabled ? { vad: createEnergyVad({ format }) } : {}),
    ...(wake ? { wake } : {}),
    rssMb: () => Math.round(process.memoryUsage.rss() / 1048576),
    log: (e: LogEvent) => {
      // The ring first, and whatever the terminal shows: a light is the only status a person across the room has.
      const state = ringForPipelineEvent(e);
      if (state) void opts.ring?.show(state).catch(() => { /* a ring that cannot be written must not stop listening */ });
      if (opts.quiet) return;
      if (QUIET_EVENTS.has(e.event)) return;
      io.err(JSON.stringify(e) + "\n");
    },
  });
  const listener = createEdgeListener({ pipeline, gate: gated });
  return { listener, stop: () => listener.stop(), addressed: Boolean(wake), arm: () => listener.arm() };
}
