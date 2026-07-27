import {
  matchAppsByName,
  type PlatformProvider, type DeviceInfo, type AppEntry,
  type InputSource, type RemoteKey, type VoicePipeline,
} from "@tv-ai-agent/platform-api";

/**
 * In-memory adapter. Lets the whole runtime run in a normal browser or Node for
 * development, demos and CI, with no TV present. Also the reference for what an
 * adapter must implement.
 */
export function createWebAdapter(): PlatformProvider {
  const state = {
    volume: 20,
    muted: false,
    input: "tv" as InputSource,
    kv: new Map<string, string>(),
    apps: [
      { id: "com.netflix.ninja", name: "Netflix" },
      { id: "com.google.android.youtube.tv", name: "YouTube" },
    ] as AppEntry[],
  };

  const voice = createWebVoice();

  const device: DeviceInfo = {
    os: "web", osVersion: navigatorVersion(), soc: "unknown", model: "dev-browser",
    capabilities: { media: true, voice: voice !== undefined },
  };

  const provider: PlatformProvider = {
    device,
    voice,
    system: {
      getVolume: async () => state.volume,
      setVolume: async (l) => { state.volume = clamp(l); },
      getMute: async () => state.muted,
      setMute: async (m) => { state.muted = m; },
      getInputSource: async () => state.input,
      setInputSource: async (s) => { state.input = s; },
      powerStandby: async () => { /* no-op in browser */ },
    },
    apps: {
      listInstalledApps: async () => state.apps,
      launchApp: async (id) => { console.info("[web] launch", id); },
      getForegroundApp: async () => null,
      findAppsByName: async (q) => matchAppsByName(state.apps, q),
    },
    navigation: {
      sendKey: async (k: RemoteKey) => { console.info("[web] key", k); },
      isAvailable: async () => true,
    },
    network: { isOnline: async () => true, connectionType: async () => "ethernet" },
    storage: {
      get: async (k) => state.kv.get(k) ?? null,
      set: async (k, v) => { state.kv.set(k, v); },
      delete: async (k) => { state.kv.delete(k); },
    },
    media: {
      play: async (uri) => { console.info("[web] play", uri); },
      pause: async () => { console.info("[web] pause"); },
      resume: async () => { console.info("[web] resume"); },
      seek: async (ms) => { console.info("[web] seek", ms); },
    },
    has: (cap) => cap in provider && (provider as any)[cap] !== undefined,
    init: async () => { /* nothing to wire */ },
  };
  return provider;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
function navigatorVersion(): string {
  return typeof navigator !== "undefined" ? navigator.userAgent : "node";
}

/**
 * Browser voice pipeline via the Web Speech API (SpeechRecognition + speech
 * synthesis). Feature-detected: returns undefined in Node/CI and on engines
 * without support, so the adapter reports voice unavailable via `has("voice")`.
 * This gives the dev harness real speech-in/out with no extra dependencies.
 */
function createWebVoice(): VoicePipeline | undefined {
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
      synth.speak(new w.SpeechSynthesisUtterance(text));
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
