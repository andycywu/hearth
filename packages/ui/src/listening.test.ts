import { describe, it, expect, vi, afterEach } from "vitest";
import type { VoicePipeline } from "@hearthkit/platform-api";
import { createListeningState } from "./listening.js";

/**
 * A pipeline whose recognition attempts are driven by the test, so every outcome
 * a real one produces — a result, no match, silence, an error — can be replayed.
 */
function fakeVoice(opts: { withEndSignal?: boolean; startFails?: boolean } = {}) {
  const endSubs = new Set<() => void>();
  const calls: string[] = [];
  const voice: VoicePipeline = {
    startListening: async () => {
      calls.push("start");
      if (opts.startFails) throw new Error("no recognizer");
    },
    stopListening: async () => { calls.push("stop"); },
    onTranscript: () => () => {},
    speak: async () => {},
    ...(opts.withEndSignal === false ? {} : {
      onListeningEnd: (cb: () => void) => {
        endSubs.add(cb);
        return () => { endSubs.delete(cb); };
      },
    }),
  };
  return { voice, calls, endAttempt: () => endSubs.forEach((cb) => cb()), subs: endSubs };
}

afterEach(() => { vi.useRealTimers(); });

describe("createListeningState", () => {
  it("starts idle", () => {
    const { voice } = fakeVoice();
    expect(createListeningState({ voice, onChange: () => {} }).listening()).toBe(false);
  });

  it("reports the change once, not on every call", async () => {
    const { voice } = fakeVoice();
    const seen: boolean[] = [];
    const s = createListeningState({ voice, onChange: (v) => seen.push(v) });
    await s.start();
    await s.start();
    expect(seen).toEqual([true]);
    expect(s.listening()).toBe(true);
  });

  it("clears when an attempt ends without a transcript", async () => {
    // The bug this whole module exists for. A no-match closed the microphone and
    // left the flag set, so the UI said "Listening…" forever and every later
    // press was a no-op — voice was dead until reload.
    const { voice, endAttempt } = fakeVoice();
    const seen: boolean[] = [];
    const s = createListeningState({ voice, onChange: (v) => seen.push(v) });
    await s.start();
    endAttempt();
    expect(s.listening()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("can start again after an attempt that found nothing", async () => {
    const { voice, calls, endAttempt } = fakeVoice();
    const s = createListeningState({ voice, onChange: () => {} });
    await s.start();
    endAttempt();
    await s.start();
    expect(calls).toEqual(["start", "start"]);
  });

  it("ignores an end signal when it isn't listening", async () => {
    const { voice, endAttempt } = fakeVoice();
    const seen: boolean[] = [];
    createListeningState({ voice, onChange: (v) => seen.push(v) });
    endAttempt();
    expect(seen).toEqual([]);
  });

  it("clears when the pipeline can't start at all", async () => {
    // Nothing will report an end in this case, so start() is the only chance.
    const { voice } = fakeVoice({ startFails: true });
    const s = createListeningState({ voice, onChange: () => {} });
    await s.start();
    expect(s.listening()).toBe(false);
  });

  it("stops on request, and asks the pipeline to stop", async () => {
    const { voice, calls } = fakeVoice();
    const s = createListeningState({ voice, onChange: () => {} });
    await s.start();
    await s.stop();
    expect(calls).toEqual(["start", "stop"]);
    expect(s.listening()).toBe(false);
  });

  it("doesn't ask the pipeline to stop when it isn't listening", async () => {
    const { voice, calls } = fakeVoice();
    const s = createListeningState({ voice, onChange: () => {} });
    await s.stop();
    expect(calls).toEqual([]);
  });

  it("toggles: press to talk, press again to give up", async () => {
    const { voice, calls } = fakeVoice();
    const s = createListeningState({ voice, onChange: () => {} });
    await s.toggle();
    expect(s.listening()).toBe(true);
    await s.toggle();
    expect(s.listening()).toBe(false);
    expect(calls).toEqual(["start", "stop"]);
  });

  it("clears even when the pipeline's stop() rejects", async () => {
    const { voice } = fakeVoice();
    voice.stopListening = async () => { throw new Error("already stopped"); };
    const s = createListeningState({ voice, onChange: () => {} });
    await s.start();
    await expect(s.stop()).rejects.toThrow();
    expect(s.listening()).toBe(false);
  });

  describe("the backstop", () => {
    it("clears an adapter that never reports an end", async () => {
      vi.useFakeTimers();
      // Adapters may legitimately not implement onListeningEnd — the contract
      // makes it optional — and being stuck is the worst state available.
      const { voice, subs } = fakeVoice({ withEndSignal: false });
      expect(subs.size).toBe(0);
      const s = createListeningState({ voice, onChange: () => {}, safetyMs: 1000 });
      await s.start();
      expect(s.listening()).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(s.listening()).toBe(false);
    });

    it("doesn't fire after the real signal already cleared it", async () => {
      vi.useFakeTimers();
      const { voice, endAttempt } = fakeVoice();
      const seen: boolean[] = [];
      const s = createListeningState({ voice, onChange: (v) => seen.push(v), safetyMs: 1000 });
      await s.start();
      endAttempt();
      vi.advanceTimersByTime(5000);
      expect(seen).toEqual([true, false]);
    });

    it("re-arms for each attempt rather than expiring once", async () => {
      vi.useFakeTimers();
      const { voice, endAttempt } = fakeVoice();
      const s = createListeningState({ voice, onChange: () => {}, safetyMs: 1000 });
      await s.start();
      endAttempt();
      await s.start();
      vi.advanceTimersByTime(999);
      expect(s.listening()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(s.listening()).toBe(false);
    });

    it("can be turned off", async () => {
      vi.useFakeTimers();
      const { voice } = fakeVoice({ withEndSignal: false });
      const s = createListeningState({ voice, onChange: () => {}, safetyMs: 0 });
      await s.start();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(s.listening()).toBe(true);
    });
  });

  it("unsubscribes and resets on destroy", async () => {
    const { voice, endAttempt, subs } = fakeVoice();
    const s = createListeningState({ voice, onChange: () => {} });
    await s.start();
    s.destroy();
    expect(s.listening()).toBe(false);
    expect(subs.size).toBe(0);
    endAttempt();     // must not throw or resurrect anything
    expect(s.listening()).toBe(false);
  });
});
