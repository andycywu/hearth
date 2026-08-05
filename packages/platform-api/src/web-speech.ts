import type { VoicePipeline } from "./index.js";

/**
 * A `VoicePipeline` on the Web Speech API, for any adapter whose runtime is a
 * browser engine — which is three of the four: the dev harness, Tizen and webOS
 * all run in a Chromium-based WebView.
 *
 * Shared rather than copied because the Tizen TV emulator turned out to expose
 * `speechSynthesis` and `webkitSpeechRecognition`, so voice there needs no native
 * code and no vendor agreement. Android is the exception: its WebView is not a
 * secure context in our setup (the app is served over http so a local model is
 * reachable), which rules Web Speech out, so it goes through the native bridge.
 *
 * Feature-detected, returning undefined when neither half exists, so
 * `has("voice")` stays honest instead of advertising a pipeline that throws.
 *
 * A caveat worth knowing before trusting this on a TV: `webkitSpeechRecognition`
 * *existing* is not the same as it *working*. Chromium's implementation sends
 * audio to a cloud service, so on a device with no route it will exist and then
 * fail. `speechSynthesis` is local and far more likely to just work.
 */
export function createWebSpeechPipeline(): VoicePipeline | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as any;
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const synth: any = w.speechSynthesis;
  if (!SR && !synth) return undefined;

  const listeners = new Set<(text: string, isFinal: boolean) => void>();
  let recognition: any;
  let wake: any;

  return {
    startListening: async () => {
      if (!SR) throw new Error("SpeechRecognition unavailable on this engine");
      recognition = new SR();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          listeners.forEach((cb) => cb(r[0].transcript, r.isFinal));
        }
      };
      recognition.start();
    },
    stopListening: async () => { recognition?.stop?.(); },
    onTranscript: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    speak: async (text: string) => {
      if (!synth || !w.SpeechSynthesisUtterance) return;
      synth.cancel();
      // Resolve when the utterance finishes rather than when it's queued: the
      // avatar's speaking state is driven off this, and resolving early leaves
      // its mouth moving after the sound stopped.
      await new Promise<void>((resolve) => {
        const utterance = new w.SpeechSynthesisUtterance(text);
        let settled = false;
        const done = (): void => { if (!settled) { settled = true; resolve(); } };
        utterance.onend = done;
        utterance.onerror = done;
        synth.speak(utterance);
        // Some engines never fire onend for a cancelled or empty utterance.
        setTimeout(done, 30_000);
      });
    },
    startWakeWord: async (phrase: string, onWake: () => void) => {
      if (!SR) throw new Error("SpeechRecognition unavailable on this engine");
      const needle = phrase.trim().toLowerCase();
      wake = new SR();
      wake.continuous = true;
      wake.interimResults = true;
      wake.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const heard = String(e.results[i][0].transcript).toLowerCase();
          if (heard.includes(needle)) {
            try { wake.stop(); } catch { /* ignore */ }
            onWake();
            return;
          }
        }
      };
      // Some engines auto-stop; restart to keep listening until stopWakeWord.
      wake.onend = () => { if (wake) { try { wake.start(); } catch { /* ignore */ } } };
      wake.start();
    },
    stopWakeWord: async () => {
      const w2 = wake;
      wake = undefined;
      try { w2?.stop?.(); } catch { /* ignore */ }
    },
  };
}
