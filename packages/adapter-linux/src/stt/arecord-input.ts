/**
 * The microphone, as a stream.
 *
 * `voice.ts` records a fixed window to a file and reads it back; that cannot
 * feed a streaming recogniser, which wants audio as it is spoken. This runs
 * `arecord` to stdout as raw PCM and yields it chunk by chunk — nothing is
 * written to disk and nothing is copied except to keep a sample whole.
 */
import type { AudioFormat, AudioInput } from "@hearthkit/edge-voice";
import { systemSpawner, type Spawner } from "./process.js";

export interface ArecordInputOptions {
  /** ALSA capture device; `default` follows `/etc/asound.conf`. */
  device: string;
  format: AudioFormat;
  spawn?: Spawner;
}

export function createArecordInput(o: ArecordInputOptions): AudioInput {
  const spawn = o.spawn ?? systemSpawner;
  let proc: ReturnType<Spawner> | undefined;
  let closed = false;

  return {
    format: o.format,

    open() {
      return (async function* () {
        proc = spawn("arecord", [
          "-D", o.device, "-f", "S16_LE", "-r", String(o.format.sampleRate),
          "-c", String(o.format.channels), "-t", "raw", "-q",
        ]);
        let spare: number | undefined;       // an odd trailing byte, held for the next chunk
        for await (const raw of proc.stdout) {
          let chunk = raw;
          if (spare !== undefined) {
            const joined = new Uint8Array(chunk.byteLength + 1);
            joined[0] = spare;
            joined.set(chunk, 1);
            chunk = joined;
            spare = undefined;
          }
          if (chunk.byteLength % 2 === 1) {
            spare = chunk[chunk.byteLength - 1];
            chunk = chunk.subarray(0, chunk.byteLength - 1);
          }
          if (chunk.byteLength > 0) yield chunk;
        }
        const code = await proc.exit;
        // Closed on purpose is the end of the stream; anything else is the device going away.
        if (!closed) {
          const why = proc.stderr().trim() || (code === null ? "could not be started" : `exit ${code}`);
          throw new Error(`arecord stopped capturing from "${o.device}": ${why}`);
        }
      })();
    },

    async close() {
      closed = true;
      proc?.kill();
    },
  };
}
