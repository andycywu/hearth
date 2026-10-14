/**
 * A WAV file, played into the pipeline as if it were a microphone.
 *
 * For testing the whole voice path — recogniser, wake word, agent, television — with
 * speech that is the same every time, on a box nobody has to stand in front of.
 * It is paced to the audio's own clock, because the gated microphone drops what
 * arrives while the agent is busy: a file read at full speed would have said
 * everything before the first answer was finished and had its second sentence
 * thrown away. It ends when the file does, which the pipeline reports as the
 * microphone closing; a caller that wants to keep listening past it appends
 * silence to the file.
 */
import { readFile } from "node:fs/promises";
import { parseWav, type AudioFormat, type AudioInput } from "@hearthkit/edge-voice";

export interface WavFileInputOptions {
  path: string;
  /** What the pipeline expects. A file in any other rate or channel count is refused, not converted. */
  format: AudioFormat;
  /** Milliseconds of audio per chunk. Default 100. */
  chunkMs?: number;
  /** Pace to the audio clock. Default true; false for a test that supplies its own `sleep`. */
  paced?: boolean;
  sleep?: (ms: number) => Promise<void>;
  read?: (path: string) => Promise<Uint8Array>;
}

export function createWavFileInput(o: WavFileInputOptions): AudioInput {
  const chunkMs = o.chunkMs ?? 100;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let closed = false;
  return {
    format: o.format,
    open() {
      return (async function* () {
        const wav = parseWav(await (o.read ?? (async (p) => new Uint8Array(await readFile(p))))(o.path));
        if (wav.format.sampleRate !== o.format.sampleRate || wav.format.channels !== o.format.channels) {
          throw new Error(
            `${o.path} is ${wav.format.sampleRate} Hz x ${wav.format.channels}ch; the pipeline wants ` +
            `${o.format.sampleRate} Hz x ${o.format.channels}ch and does not resample`,
          );
        }
        const bytesPerMs = (wav.format.sampleRate * wav.format.channels * 2) / 1000;
        const step = Math.max(2, Math.floor((bytesPerMs * chunkMs) / 2) * 2);
        for (let at = 0; at < wav.pcm.byteLength && !closed; at += step) {
          yield wav.pcm.subarray(at, Math.min(at + step, wav.pcm.byteLength));
          if (o.paced !== false) await sleep(chunkMs);
        }
      })();
    },
    async close() { closed = true; },
  };
}
