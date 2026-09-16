/**
 * Voice on Linux, through ALSA and whatever speaks for this box.
 *
 * The other adapters get voice from somewhere that already exists: the browser
 * hands web, Tizen and webOS a `SpeechRecognition` and a `speechSynthesis`, and
 * Android has a native bridge to the platform's own engines. A Raspberry Pi has
 * neither. It has a microphone, a speaker, and nothing that turns one into words
 * — so this file is the first place in the repo that has to say out loud where
 * recognition comes from.
 *
 * It does not guess. `arecord` captures, `espeak-ng` speaks, and **the step in
 * between is injected**: a `Transcriber` is a function from audio to text, and a
 * build without one reports `unsupported` rather than listening to a microphone
 * it cannot understand. `createOpenAiTranscriber` is the one implementation
 * shipped here, because the runtime already speaks that schema for planning and
 * `?llm=` already points at either a cloud gateway or a box on the LAN —
 * pointing `?asr=` at a local whisper server is the same move.
 *
 * What this deliberately does **not** implement is `startWakeWord`. A wake word
 * needs an always-on detector, and the honest options on this hardware are a
 * third-party engine or a bad imitation of one. `VoicePipeline` makes those
 * methods optional precisely so an adapter can decline, and `has("voice")` stays
 * true for the half that works.
 */
import { TvUnsupportedError, type VoicePipeline } from "@hearthkit/platform-api";
import { systemRunner, type Runner } from "./run.js";

/** Long enough for a sentence, and for the transcription that follows it. */
const VOICE_TIMEOUT_MS = 60_000;

/** How one recorded utterance is turned into words. */
export type Transcriber = (audio: Uint8Array, format: CaptureFormat) => Promise<string>;

export interface CaptureFormat {
  /** ALSA sample format, e.g. `S16_LE`. */
  readonly encoding: string;
  readonly rate: number;
  readonly channels: number;
}

export interface LinuxVoiceOptions {
  run?: Runner;
  /**
   * ALSA capture device. `default` follows `/etc/asound.conf`, which is what a
   * ReSpeaker install writes — naming a card here pins it past that.
   */
  device?: string;
  /**
   * How long one listening attempt records for.
   *
   * A fixed window, and that is a real limitation stated rather than hidden:
   * there is no voice-activity detection here, so a sentence that runs past this
   * is cut off and silence before it is recorded anyway. The browser engines
   * this file stands in for do endpointing themselves. Anyone wanting better
   * should inject a `Transcriber` whose service does it.
   */
  seconds?: number;
  rate?: number;
  channels?: number;
  /** `S16_LE` by default: the format every transcription service accepts. */
  encoding?: string;
  transcribe?: Transcriber;
  /** espeak-ng voice, e.g. `cmn` for Mandarin. */
  voiceName?: string;
  /** Where a recording is written before it is read back. */
  capturePath?: string;
  /** Injected in tests; defaults to reading the captured file from disk. */
  readCapture?: (path: string) => Promise<Uint8Array>;
}

/**
 * What this box can actually do, asked rather than assumed.
 *
 * Both halves are separate questions — a Pi with a microphone HAT and no
 * `espeak-ng` can hear and not answer, and the report should say so rather than
 * reporting "voice" as one thing.
 */
export async function detectVoice(run: Runner): Promise<{ capture: boolean; tts: boolean }> {
  const [capture, tts] = await Promise.all([
    run("arecord", ["-l"]).then(
      // `arecord -l` exits 0 and prints only its header when there is no capture
      // device at all, which is why this looks for a card rather than the exit
      // code. Learned from a Pi where the check said "arecord is not installed"
      // about a machine that had it.
      (r) => r.code === 0 && /^card \d+:/m.test(r.stdout),
      () => false,
    ),
    run("espeak-ng", ["--version"]).then((r) => r.code === 0, () => false),
  ]);
  return { capture, tts };
}

export function createLinuxVoicePipeline(opts: LinuxVoiceOptions = {}): VoicePipeline {
  const run = opts.run ?? systemRunner(VOICE_TIMEOUT_MS);
  const device = opts.device ?? "default";
  const seconds = opts.seconds ?? 5;
  const format: CaptureFormat = {
    encoding: opts.encoding ?? "S16_LE",
    rate: opts.rate ?? 16_000,
    channels: opts.channels ?? 1,
  };
  const capturePath = opts.capturePath ?? "/tmp/hearth-capture.wav";
  const readCapture = opts.readCapture ?? defaultReadCapture;

  const transcriptListeners = new Set<(text: string, isFinal: boolean) => void>();
  const endListeners = new Set<() => void>();
  /**
   * Bumped by every start and every stop, so a result can tell whether it is
   * still wanted. `arecord` is run to completion through the `Runner`, which
   * hands back no process to kill — so `stopListening` cannot cut the microphone
   * off mid-word. What it *can* do is guarantee that nothing arrives afterwards,
   * and saying which of those two it is matters: a caller that pressed stop and
   * then received a transcript would have been right to call that a bug.
   */
  let attempt = 0;
  let listening = false;

  const endAttempt = (): void => {
    listening = false;
    for (const cb of endListeners) cb();
  };

  return {
    startListening: async () => {
      if (!opts.transcribe) {
        throw new TvUnsupportedError(
          "no transcriber configured — this build can record audio but has nothing to turn it " +
          "into text. Pass `transcribe` (see createOpenAiTranscriber) or point the host at a " +
          "speech endpoint.",
        );
      }
      if (listening) return;
      listening = true;
      const mine = ++attempt;

      const rec = await run("arecord", [
        "-D", device,
        "-f", format.encoding,
        "-r", String(format.rate),
        "-c", String(format.channels),
        "-d", String(seconds),
        capturePath,
      ]);
      if (rec.code !== 0) {
        endAttempt();
        throw new TvUnsupportedError(
          `arecord could not capture from "${device}": ${rec.stderr.trim() || `exit ${rec.code}`}`,
        );
      }
      if (mine !== attempt) return;   // stopped while we were recording

      let text: string;
      try {
        text = await opts.transcribe(await readCapture(capturePath), format);
      } finally {
        // The attempt is over whether or not it produced words. Anything else
        // leaves a caller listening forever to a microphone that already closed.
        if (mine === attempt) endAttempt();
      }
      if (mine !== attempt) return;

      const trimmed = text.trim();
      if (trimmed) for (const cb of transcriptListeners) cb(trimmed, true);
    },

    stopListening: async () => {
      if (!listening) return;
      attempt++;                       // anything in flight is now unwanted
      endAttempt();
    },

    onTranscript: (cb) => {
      transcriptListeners.add(cb);
      return () => transcriptListeners.delete(cb);
    },

    onListeningEnd: (cb) => {
      endListeners.add(cb);
      return () => endListeners.delete(cb);
    },

    speak: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const args = opts.voiceName ? ["-v", opts.voiceName, "--", trimmed] : ["--", trimmed];
      const said = await run("espeak-ng", args);
      if (said.code !== 0) {
        throw new TvUnsupportedError(
          `espeak-ng could not speak: ${said.stderr.trim() || `exit ${said.code}`}`,
        );
      }
    },
  };
}

async function defaultReadCapture(path: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(path));
}

export interface OpenAiTranscriberOptions {
  /** Same shape as the LLM endpoint: `http://host:port/v1`. */
  baseUrl: string;
  model?: string;
  apiKey?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Transcription over the OpenAI audio schema, which is what a local whisper
 * server speaks as readily as a cloud one.
 *
 * Deliberately the same shape as the planning endpoint: a host that already
 * decided where its model lives has already made this decision too, and a second
 * unrelated protocol would be a second thing to configure, document and get
 * wrong.
 */
export function createOpenAiTranscriber(opts: OpenAiTranscriberOptions): Transcriber {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  return async (audio) => {
    const form = new FormData();
    form.append("file", new Blob([audio as BlobPart], { type: "audio/wav" }), "capture.wav");
    form.append("model", opts.model ?? "whisper-1");
    const res = await doFetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      body: form,
    });
    if (!res.ok) {
      throw new Error(`transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json() as { text?: unknown };
    // A 200 that is not a transcript is not a transcript. Answering "" would put
    // silence and a broken endpoint on the same footing.
    if (typeof body.text !== "string") {
      throw new Error("transcription endpoint returned no text field");
    }
    return body.text;
  };
}
