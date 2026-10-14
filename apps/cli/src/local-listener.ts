/**
 * `--asr local`: the voice loop's ears, on this box.
 *
 * `listenForever` wants "wait for one utterance"; the edge pipeline is a
 * stream that has to stay up (the model takes ~20 s to load). This joins the two
 * with a gated microphone — see `adapter-linux/src/stt/listener.ts` for why the
 * gate is what keeps the agent from hearing itself.
 */
import {
  createEnergyVad, createPipeline, resolveEdgeVoiceConfig, type LogEvent,
} from "@hearthkit/edge-voice";
import { createArecordInput, createEdgeListener, createWavFileInput, gateInput, type SpeechListener } from "@hearthkit/adapter-linux";
import { defaultEngine } from "./stt.js";

export interface LocalListener {
  listener: SpeechListener;
  stop(): Promise<void>;
}

export async function createLocalListener(
  env: Record<string, string | undefined>,
  io: { err(text: string): void },
  opts: { quiet: boolean },
): Promise<LocalListener> {
  const { config, warnings } = resolveEdgeVoiceConfig(env);
  for (const w of warnings) io.err(`hearth: ${w}\n`);
  if (config.wakeWordEnabled) io.err("hearth: HEARTH_WAKE_WORD_ENABLED is set, but the edge pipeline has no wake-word detector; --wake still applies to what is transcribed\n");

  // Fails here, before the agent starts, if there is no model to listen with.
  const engine = await defaultEngine(config);
  const format = { sampleRate: config.sampleRate, channels: config.channels };
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
    rssMb: () => Math.round(process.memoryUsage.rss() / 1048576),
    log: (e: LogEvent) => {
      if (opts.quiet) return;
      if (e.event === "stt_partial" || e.event === "stt_empty") return;
      io.err(JSON.stringify(e) + "\n");
    },
  });
  const listener = createEdgeListener({ pipeline, gate: gated });
  return { listener, stop: () => listener.stop() };
}
