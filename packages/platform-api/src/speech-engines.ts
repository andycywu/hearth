/**
 * Speech APIs present in this runtime, by name.
 *
 * Checked as globals rather than by platform, because the interesting question
 * is which of them a *given firmware* actually ships — the Tizen and webOS
 * WebViews are Chromium-based, so Web Speech may be there for free, and if it is
 * then voice on those platforms needs no native code and no vendor agreement.
 *
 * It lives in platform-api rather than in the agent core, which is where it
 * started: it names Samsung's and Android's globals, and the core must not know
 * what a Samsung is. This package is already the layer that touches platform
 * surfaces — `web-speech.ts` next door sniffs `webkitSpeechRecognition` the same
 * way — so the vendor knowledge is at home here and the harness stays free of it.
 *
 * Deliberately *not* behind `PlatformProvider.voice`: the useful answer is what
 * the firmware could support whether or not an adapter wired anything up, and an
 * adapter with no voice pipeline is exactly when you want to know.
 */
export function detectSpeechEngines(): string[] {
  const g = globalThis as Record<string, unknown>;
  const found: string[] = [];
  if (g.speechSynthesis) {
    // Voice count matters: an engine with none installed is silently mute, which
    // otherwise looks identical to working TTS from up here.
    const voices = countSynthesisVoices(g.speechSynthesis);
    found.push(`speechSynthesis (TTS${voices === undefined ? "" : `, ${voices} voices`})`);
  }
  if (g.SpeechRecognition) found.push("SpeechRecognition (STT)");
  if (g.webkitSpeechRecognition) found.push("webkitSpeechRecognition (STT)");
  // Vendor extensions, checked without assuming the namespace exists.
  const webapis = g.webapis as Record<string, unknown> | undefined;
  if (webapis?.["voice"]) found.push("webapis.voice (Samsung)");
  if (webapis?.["speech"]) found.push("webapis.speech (Samsung)");
  const tizen = g.tizen as Record<string, unknown> | undefined;
  if (tizen?.["tts"]) found.push("tizen.tts");
  if (tizen?.["stt"]) found.push("tizen.stt");
  if ((g.TvNativeBridge as Record<string, unknown> | undefined)?.["startListening"]) {
    found.push("native bridge (Android)");
  }
  return found;
}

function countSynthesisVoices(synth: unknown): number | undefined {
  const getVoices = (synth as { getVoices?: () => unknown[] })?.getVoices;
  if (typeof getVoices !== "function") return undefined;
  try {
    // Some engines populate this asynchronously and report 0 on a cold call, so
    // a 0 here means "none yet", not necessarily "none ever".
    return getVoices.call(synth)?.length ?? undefined;
  } catch {
    return undefined;
  }
}
