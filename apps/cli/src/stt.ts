/**
 * `hearth stt` — microphone → VAD → speech-to-text → transcripts, and nothing else.
 *
 * No agent, no platform, no model: this is the edge voice pipeline on its own, so
 * the recogniser can be measured and tuned before anything depends on it. Final
 * transcripts go to stdout (one line each, or a Transcript as JSON with `--json`);
 * everything about how it went — the utterance's latency, memory, and with
 * HEARTH_LOG_LEVEL=debug the partials — is a JSON line on stderr, because stdout is the thing someone pipes.
 */
import {
  createEnergyVad, createPipeline, resolveEdgeVoiceConfig,
  type AudioInput, type EdgeVoiceConfig, type LogEvent, type SpeechToTextEngine, type Transcript,
} from "@hearthkit/edge-voice";
import { createArecordInput, createSherpaStt, sherpaServerCommand, type StatusRing } from "@hearthkit/adapter-linux";
import { ringForPipelineEvent } from "./voice-ring.js";
import type { CliOptions } from "./args.js";
import { runSttBench } from "./stt-bench.js";

export interface SttIo {
  out(text: string): void;
  err(text: string): void;
}

export interface SttDeps {
  env: Record<string, string | undefined>;
  io: SttIo;
  /** Resolves when the run should end (SIGINT). Never resolves in a test that lets the input end. */
  interrupted?: Promise<void>;
  /** Substituted in tests. */
  makeInput?: (config: EdgeVoiceConfig) => AudioInput;
  makeEngine?: (config: EdgeVoiceConfig) => Promise<SpeechToTextEngine>;
  rssMb?: () => number | undefined;
  /** Benchmark file access, substituted in tests. */
  readFile?: (path: string) => Promise<Uint8Array>;
  writeFile?: (path: string, data: string) => Promise<void>;
  /** The status ring: loading, hearing, recognising, and still when idle. */
  ring?: StatusRing | undefined;
}

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const EVENT_LEVEL: Record<string, keyof typeof LEVEL_ORDER> = { stt_error: "error", stt_empty: "debug", stt_partial: "debug" };

/** Backends this build can construct. The names `whisper` and `vosk` are reserved, not promised. */
const BACKENDS = ["sherpa"] as const;

export async function runStt(opts: CliOptions, deps: SttDeps): Promise<number> {
  const { io } = deps;
  if (opts.sttBench) return runSttBench(opts, opts.sttBench, { ...deps, makeEngine: deps.makeEngine ?? defaultEngine });

  const { config, warnings } = resolveEdgeVoiceConfig(deps.env);
  for (const w of warnings) io.err(`hearth: ${w}\n`);

  // Two switches the interface has and this build does not. Said, not ignored: a
  // config that asks for a wake word and gets an always-open microphone has been lied to.
  if (config.wakeWordEnabled) io.err("hearth: HEARTH_WAKE_WORD_ENABLED is set, but this build has no wake-word detector yet; listening without one\n");
  if (config.audioPreprocessingEnabled) io.err("hearth: HEARTH_AUDIO_PREPROCESSING_ENABLED is set, but no AEC/NS/AGC backend exists yet; audio is passed through untouched\n");

  const quiet = opts.quiet;
  const wanted = LEVEL_ORDER[config.logLevel];
  const log = (e: LogEvent): void => {
    const state = ringForPipelineEvent(e);
    if (state) void deps.ring?.show(state).catch(() => {});
    if (quiet) return;
    const level = EVENT_LEVEL[e.event] ?? "info";
    if (LEVEL_ORDER[level] >= wanted) io.err(JSON.stringify(e) + "\n");
  };

  let engine: SpeechToTextEngine;
  try {
    engine = await (deps.makeEngine ?? defaultEngine)(config);
  } catch (err) {
    io.err(`hearth: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const format = { sampleRate: config.sampleRate, channels: config.channels };
  const input = (deps.makeInput ?? ((c) => createArecordInput({ device: c.audioDevice, format })))(config);
  const pipeline = createPipeline({
    input, stt: engine,
    ...(config.vadEnabled ? { vad: createEnergyVad({ format }) } : {}),
    ...(deps.rssMb ? { rssMb: deps.rssMb } : {}),
    log,
  });

  pipeline.onTranscript((t: Transcript) => {
    if (!t.isFinal) {
      log({ event: "stt_partial", backend: t.backend, text: t.text, at_ms: Math.round(t.endTimeMs) });
      return;
    }
    io.out(opts.json ? JSON.stringify(t) + "\n" : t.text + "\n");
  });

  let faulted: string | undefined;
  const running = pipeline.run().catch((err: unknown) => { faulted = err instanceof Error ? err.message : String(err); });
  if (deps.interrupted) void deps.interrupted.then(() => pipeline.stop());
  await running;

  if (faulted) { io.err(`hearth: ${faulted}\n`); return 1; }
  return 0;
}

export async function defaultEngine(config: EdgeVoiceConfig): Promise<SpeechToTextEngine> {
  if (!(BACKENDS as readonly string[]).includes(config.sttBackend)) {
    throw new Error(
      `HEARTH_STT_BACKEND=${config.sttBackend}: this build has only ${BACKENDS.join(", ")}. ` +
      "whisper and vosk are planned behind the same interface, not built.",
    );
  }
  const model = config.sttModelPath;
  if (config.sttServerUrl) {
    return createSherpaStt({ url: config.sttServerUrl, model: model ?? "external" });
  }
  if (!model || !config.sttRuntimePath) {
    throw new Error(
      "no speech model configured. Set HEARTH_STT_MODEL_PATH (an unpacked sherpa-onnx transducer model) " +
      "and HEARTH_STT_RUNTIME_PATH (the unpacked sherpa-onnx release), or HEARTH_STT_SERVER_URL for a " +
      "server that is already running. See docs/edge-voice.md.",
    );
  }
  const server = await sherpaServerCommand({ releaseDir: config.sttRuntimePath, modelDir: model });
  return createSherpaStt({ model: model.split("/").filter(Boolean).pop() ?? model, server });
}
