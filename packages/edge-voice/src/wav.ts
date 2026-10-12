/**
 * Just enough WAV to feed a recogniser from a file.
 *
 * Walks the RIFF chunks rather than assuming 44 bytes of header, and refuses
 * anything that is not 16-bit PCM — a benchmark that silently resampled or
 * re-quantised would be measuring the converter. The refusal says what it found.
 */
import type { AudioFormat } from "./types.js";

export interface ParsedWav {
  readonly format: AudioFormat;
  /** Raw S16LE samples, interleaved, a view into the input. */
  readonly pcm: Uint8Array;
  readonly durationMs: number;
}

export function parseWav(bytes: Uint8Array): ParsedWav {
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let fmt: { code: number; channels: number; rate: number; bits: number } | undefined;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      fmt = {
        code: view.getUint16(body, true), channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV has a data chunk before its fmt chunk");
      if (fmt.code !== 1 || fmt.bits !== 16) {
        throw new Error(`WAV is not 16-bit PCM (format ${fmt.code}, ${fmt.bits} bits); convert it with: sox in.wav -b 16 out.wav`);
      }
      const end = Math.min(bytes.length, body + size);
      // A whole number of frames; a truncated trailing sample is dropped, not guessed.
      const frame = fmt.channels * 2;
      const pcm = bytes.subarray(body, body + Math.floor((end - body) / frame) * frame);
      return {
        format: { sampleRate: fmt.rate, channels: fmt.channels },
        pcm,
        durationMs: (pcm.byteLength / frame / fmt.rate) * 1000,
      };
    }
    at = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}
