/**
 * The edge pipeline, shaped as "wait for one utterance".
 *
 * `listenForever` (apps/cli/src/voice-loop.ts) opens the microphone, takes what
 * was said, runs the agent, speaks, and only then opens the microphone again.
 * That ordering matters — otherwise the next window records the agent's own
 * reply — and it is the reason this is not simply "run the pipeline and print
 * what comes out". The pipeline here runs for the life of the process (the model
 * takes ~20 s to load; it cannot be started per sentence), but its microphone is
 * **gated**: audio is read continuously so nothing backs up in the pipe, and is
 * dropped unless somebody is listening.
 *
 * Each `listen()` opens the gate, returns the next final transcript, and closes
 * it again. Between calls — while the agent thinks and speaks — nothing reaches
 * the recogniser.
 */
import type { AudioInput, Pipeline } from "@hearthkit/edge-voice";
import type { SpeechListener } from "../voice.js";

/** An `AudioInput` that reads its source all the time and passes chunks on only while open. */
export function gateInput(inner: AudioInput): AudioInput & { setOpen(open: boolean): void } {
  let open = false;
  return {
    format: inner.format,
    setOpen(next) { open = next; },
    open() {
      return (async function* () {
        for await (const chunk of inner.open()) if (open) yield chunk;
      })();
    },
    close: () => inner.close(),
  };
}

export interface EdgeListenerOptions {
  /** Built by the caller around `gateInput`, so the gate and the pipeline share one input. */
  pipeline: Pipeline;
  gate: { setOpen(open: boolean): void };
}

export function createEdgeListener(o: EdgeListenerOptions): SpeechListener & { stop(): Promise<void>; arm(): void } {
  let started = false;
  let running: Promise<void> = Promise.resolve();
  let fault: Error | undefined;
  let waiting: { resolve(text: string): void; reject(err: Error): void } | undefined;
  // A final that arrives with nobody waiting (the gate closed a moment too late) is dropped:
  // it is an answer to a question nobody asked.

  o.pipeline.onTranscript((t) => {
    if (!t.isFinal || !waiting) return;
    const w = waiting;
    waiting = undefined;
    o.gate.setOpen(false);
    w.resolve(t.text);
  });

  const start = (): void => {
    if (started) return;
    started = true;
    running = o.pipeline.run().then(
      () => { fault ??= new Error("the speech pipeline ended (the microphone closed)"); },
      (err: unknown) => { fault = err instanceof Error ? err : new Error(String(err)); },
    ).finally(() => {
      o.gate.setOpen(false);
      const w = waiting;
      waiting = undefined;
      if (w && fault) w.reject(fault);
    });
  };

  return {
    /** Take the next utterance without the wake word; see `Pipeline.arm`. */
    arm() { o.pipeline.arm(); },

    listen() {
      if (fault) return Promise.reject(fault);
      start();
      return new Promise<string>((resolve, reject) => {
        waiting = { resolve, reject };
        o.gate.setOpen(true);
      });
    },

    cancel() {
      o.gate.setOpen(false);
      const w = waiting;
      waiting = undefined;
      w?.resolve("");
    },

    async stop() {
      this.cancel();
      if (started && !fault) await o.pipeline.stop();
      // `stop` closes the microphone; the pipeline then unwinds and closes the engine, and a
      // caller that is about to exit must wait for that or leave a model server behind.
      await running;
    },
  };
}
