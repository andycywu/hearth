import type { VoicePipeline } from "@tv-ai-agent/platform-api";

/**
 * "Is the microphone open" — owned in one place.
 *
 * There were two copies of this: one in `mountDeviceShell` for the device hosts
 * and one in the dev harness, whose own comment said the state must not drift
 * apart. They drifted, and both had the same defect. Only a final transcript
 * cleared the flag, so any other outcome — no match, silence, an error — left it
 * set forever: the microphone had closed, the UI still said Listening, and every
 * later press was a no-op because the flag said an attempt was already running.
 * Voice was dead until reload.
 *
 * Two guarantees, which is the whole reason this exists:
 *
 *  - `onListeningEnd` is subscribed, so *every* outcome clears the state, not
 *    just the successful one.
 *  - A timeout backs that up, for an adapter that doesn't implement the signal or
 *    misses an event. Being stuck is the worst state available here, so it is
 *    worth spending a stray timer to make it unreachable.
 */

export interface ListeningStateOptions {
  voice: VoicePipeline;
  /** Called whenever the state changes, and only when it actually changes. */
  onChange(listening: boolean): void;
  /**
   * Backstop, in ms. Default 30s — longer than any plausible attempt, so it only
   * ever fires when the real end signal didn't arrive. 0 disables it.
   */
  safetyMs?: number;
}

export interface ListeningState {
  listening(): boolean;
  /** Open the microphone. No-op while an attempt is already running. */
  start(): Promise<void>;
  /** Give up on the current attempt. No-op when idle. */
  stop(): Promise<void>;
  /** Press to talk, press again to give up. */
  toggle(): Promise<void>;
  destroy(): void;
}

export function createListeningState(opts: ListeningStateOptions): ListeningState {
  const { voice } = opts;
  const safetyMs = opts.safetyMs ?? 30_000;

  let listening = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clear(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!listening) return;
    listening = false;
    opts.onChange(false);
  }

  const unsubscribe = voice.onListeningEnd?.(clear);

  async function start(): Promise<void> {
    if (listening) return;
    listening = true;
    opts.onChange(true);
    if (safetyMs > 0) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(clear, safetyMs);
    }
    try {
      await voice.startListening();
    } catch {
      // A pipeline that can't start at all — no recognizer, permission refused.
      // Nothing will report an end, so this is the only chance to reset.
      clear();
    }
  }

  async function stop(): Promise<void> {
    if (!listening) return;
    try {
      await voice.stopListening();
    } finally {
      // Also reset here rather than waiting for `onListeningEnd`: an adapter that
      // doesn't emit it would leave the state latched by our own stop request.
      clear();
    }
  }

  return {
    listening: () => listening,
    start,
    stop,
    toggle: () => (listening ? stop() : start()),
    destroy: () => {
      unsubscribe?.();
      clear();
    },
  };
}
