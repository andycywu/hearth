/**
 * The edge voice contracts.
 *
 *   AudioInput → AudioPreprocessor → WakeWordDetector → VoiceActivityDetector
 *     → SpeechToTextEngine → Transcript → IntentRouter
 *
 * Every stage is an interface and nothing here names an engine. Audio is always
 * 16-bit little-endian PCM, which is what `arecord`, sherpa-onnx and every
 * transcription service accept; a backend that wants floats converts inside
 * itself, so the pipeline never copies audio to change its shape.
 */

export interface AudioFormat {
  /** Hz. Edge STT models are trained at 16 000. */
  readonly sampleRate: number;
  readonly channels: number;
}

/** A microphone, a file, or a test's script — anything that yields PCM16 chunks. */
export interface AudioInput {
  readonly format: AudioFormat;
  /** Ends when the source ends (a file) or rejects when it fails (a device that went away). */
  open(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

/** AEC / noise suppression / gain. Same shape in and out. */
export interface AudioPreprocessor {
  readonly name: string;
  process(chunk: Uint8Array): Uint8Array;
}

/** Cheap enough to run on every chunk — it is the thing that keeps STT idle. */
export interface WakeWordDetector {
  readonly name: string;
  /** True on the chunk in which the phrase was heard. */
  accept(chunk: Uint8Array): boolean;
  reset(): void;
}

export type VadEvent =
  | { readonly type: "speech_started"; readonly atMs: number }
  /** The first chunk after `speech_started` includes whatever pre-roll the detector keeps. */
  | { readonly type: "speech_chunk"; readonly chunk: Uint8Array; readonly atMs: number }
  | { readonly type: "speech_ended"; readonly atMs: number };

export interface VoiceActivityDetector {
  readonly name: string;
  /** `atMs` values are positions in the audio stream, not wall-clock time. */
  accept(chunk: Uint8Array): VadEvent[];
  reset(): void;
}

/** What an engine says about one stretch of audio. Times are the pipeline's to add. */
export interface SttResult {
  readonly text: string;
  readonly language?: string | undefined;
  readonly isFinal: boolean;
  /** `null` unless the engine reports something meaningful. Never invented. */
  readonly confidence: number | null;
}

/** One utterance's worth of recognition. */
export interface SttSession {
  /** Partial results the engine produced for this chunk, if it streams; otherwise `[]`. */
  push(chunk: Uint8Array): Promise<SttResult[]>;
  /** Flush and return the final result. */
  finish(): Promise<SttResult>;
  /** Drop it without a result — used when the pipeline stops mid-utterance. */
  abort(): Promise<void>;
}

export interface SpeechToTextEngine {
  /** `"sherpa"`, `"whisper"`, `"vosk"`, … — appears on every Transcript and log line. */
  readonly backend: string;
  readonly model: string;
  /** True if `push` can return partials. */
  readonly streaming: boolean;
  /** Resident MB of the engine's own process, if it runs in one and that can be read. */
  rssMb?(): number | undefined;
  /** Load the model. Rejects if it is missing or does not fit in memory. */
  load(): Promise<void>;
  start(): Promise<SttSession>;
  close(): Promise<void>;
}

export interface Transcript {
  readonly text: string;
  readonly language: string | null;
  readonly isFinal: boolean;
  readonly confidence: number | null;
  /** Position in the audio stream, ms. */
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly backend: string;
}

/** Where a transcript goes. A local device command never needs the network. */
export type Intent =
  | { readonly kind: "LOCAL_COMMAND"; readonly text: string }
  | { readonly kind: "AI_TASK"; readonly text: string };

export interface IntentRouter {
  route(transcript: Transcript): Promise<Intent>;
}

/**
 * The seam to whatever answers an AI task. Hearth does not know what is behind
 * it and does not choose a model: `escalate` means "this gate could not settle
 * it", and what happens next belongs to the router behind the gate.
 */
export type AiTaskResult =
  | { readonly outcome: "solved"; readonly result: string }
  | { readonly outcome: "escalate"; readonly reason: string };

export interface AiTaskClient {
  solve(task: string, signal?: AbortSignal): Promise<AiTaskResult>;
}

/** One structured log line: `event` plus flat, JSON-safe fields. */
export interface LogEvent {
  readonly event: string;
  readonly [field: string]: string | number | boolean | null | undefined;
}
