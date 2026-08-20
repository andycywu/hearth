import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertProviderContract } from "@hearthkit/platform-api";
import { createAospAdapter } from "./index.js";

const bridge = (): any => (globalThis as any).TvNativeBridge;

/** Minimal in-memory stand-in for the Kotlin TvNativeBridge. */
function installMockBridge(): void {
  const state = { volume: 20, muted: false, input: "app", kv: new Map<string, string>() };
  const apps = [
    { id: "com.netflix.ninja", name: "Netflix" },
    { id: "com.google.android.youtube.tv", name: "YouTube" },
  ];
  (globalThis as any).TvNativeBridge = {
    getDeviceInfo: () => JSON.stringify({
      os: "aosp", osVersion: "14", soc: "mediatek", model: "MTK-ref",
      capabilities: { media: false, voice: false },
    }),
    getVolume: () => state.volume,
    setVolume: (l: number) => { state.volume = Math.max(0, Math.min(100, Math.round(l))); },
    getMute: () => state.muted,
    setMute: (m: boolean) => { state.muted = m; },
    getInputSource: () => state.input,
    setInputSource: (s: string) => { state.input = s; },
    powerStandby: () => {},
    listInstalledApps: () => JSON.stringify(apps),
    launchApp: () => {},
    getForegroundApp: () => "null",
    // Mirrors TvNativeBridge.sendKey: the real one throws until the
    // accessibility service is connected. A mock that accepted the key and did
    // nothing let the adapter claim navigation worked when it didn't.
    isAccessibilityEnabled: () => true,
    sendKey: () => {
      if (!(globalThis as any).TvNativeBridge.isAccessibilityEnabled?.()) {
        throw new Error("Not supported: accessibility service not enabled");
      }
    },
    isOnline: () => true,
    connectionType: () => "ethernet",
    kvGet: (k: string) => state.kv.get(k) ?? "",
    kvSet: (k: string, v: string) => { state.kv.set(k, v); },
    kvDelete: (k: string) => { state.kv.delete(k); },
  };
}

describe("adapter-aosp", () => {
  beforeEach(() => installMockBridge());
  afterEach(() => { delete (globalThis as any).TvNativeBridge; });

  it("satisfies the provider contract via the native bridge", async () => {
    await assertProviderContract(() => createAospAdapter());
  });

  it("throws a useful error outside the host WebView", () => {
    delete (globalThis as any).TvNativeBridge;
    expect(() => createAospAdapter()).toThrow(/TvNativeBridge not found/);
  });

  describe("navigation readiness", () => {
    // On retail Android TV, keys only work once the user enables the
    // accessibility service — so isAvailable() must mirror the service state,
    // letting the agent prompt for setup instead of silently doing nothing.
    it("is unavailable while the accessibility service is off", async () => {
      bridge().isAccessibilityEnabled = () => false;
      expect(await createAospAdapter().navigation.isAvailable!()).toBe(false);
    });

    it("is available once the accessibility service is on", async () => {
      bridge().isAccessibilityEnabled = () => true;
      expect(await createAospAdapter().navigation.isAvailable!()).toBe(true);
    });

    it("is unavailable on an older host that doesn't expose the check", async () => {
      // The bridge method is optional; assume "not ready" rather than "ready".
      delete bridge().isAccessibilityEnabled;
      expect(await createAospAdapter().navigation.isAvailable!()).toBe(false);
    });

    it("routes requestSetup to the Accessibility settings screen", async () => {
      let opened = 0;
      bridge().openAccessibilitySettings = () => { opened++; };
      await createAospAdapter().navigation.requestSetup!();
      expect(opened).toBe(1);
    });

    it("doesn't blow up when the host can't open settings", async () => {
      expect(bridge().openAccessibilitySettings).toBeUndefined();
      await expect(createAospAdapter().navigation.requestSetup!()).resolves.toBeUndefined();
    });
  });

  describe("opaque native exceptions", () => {
    // Android replaces whatever Kotlin throws inside a @JavascriptInterface
    // method with a generic message, so the adapter has to supply the reason.
    const androidStyleThrow = () => { throw new Error("Java exception was raised during method invocation"); };

    it("explains an unavailable input switch", async () => {
      bridge().setInputSource = androidStyleThrow;
      await expect(createAospAdapter().system.setInputSource("hdmi1"))
        .rejects.toThrow(/Not supported: setInputSource .*platform signature/);
    });

    it("explains an unavailable standby", async () => {
      bridge().powerStandby = androidStyleThrow;
      await expect(createAospAdapter().system.powerStandby())
        .rejects.toThrow(/Not supported: powerStandby .*DEVICE_POWER/);
    });

    it("points at the accessibility service when navigation is off", async () => {
      bridge().isAccessibilityEnabled = () => false;
      bridge().sendKey = androidStyleThrow;
      await expect(createAospAdapter().navigation.sendKey("ok"))
        .rejects.toThrow(/Not supported: navigation — enable the accessibility service/);
    });

    it("blames the key, not the setup, once the service is on", async () => {
      bridge().isAccessibilityEnabled = () => true;
      bridge().sendKey = androidStyleThrow;
      await expect(createAospAdapter().navigation.sendKey("channelup"))
        .rejects.toThrow(/Not supported: key 'channelup' via accessibility/);
    });

    it("stays quiet when the native call succeeds", async () => {
      await expect(createAospAdapter().navigation.sendKey("ok")).resolves.toBeUndefined();
    });
  });

  it("clamps the volume the host receives", async () => {
    const platform = createAospAdapter();
    await platform.system.setVolume(140);
    expect(await platform.system.getVolume()).toBe(100);
    await platform.system.setVolume(-10);
    expect(await platform.system.getVolume()).toBe(0);
  });

  it("maps an absent foreground app and absent storage key to null", async () => {
    const platform = createAospAdapter();
    expect(await platform.apps.getForegroundApp()).toBeNull();
    expect(await platform.storage.get("nope")).toBeNull();
    await platform.storage.set("k", "v");
    expect(await platform.storage.get("k")).toBe("v");
  });

  describe("voice", () => {
    /** Add the speech methods a newer host APK provides. */
    const addVoice = () => {
      const calls: string[] = [];
      let stt = true;
      Object.assign(bridge(), {
        ttsAvailable: () => true,
        speak: (t: string) => calls.push(`speak:${t}`),
        stopSpeaking: () => calls.push("stopSpeaking"),
        sttAvailable: () => stt,
        sttUnavailableReason: () => (stt ? "" : "microphone permission not granted"),
        requestMicPermission: () => calls.push("requestMicPermission"),
        startListening: () => calls.push("startListening"),
        stopListening: () => calls.push("stopListening"),
      });
      return { calls, denyStt: () => { stt = false; } };
    };
    const fire = (event: unknown) => (globalThis as any).__tvVoice.onEvent(event);
    afterEach(() => { delete (globalThis as any).__tvVoice; });

    it("has no voice when the host APK doesn't offer it", () => {
      // An older APK with a newer bundle must degrade to text, not throw on the
      // first spoken command.
      const platform = createAospAdapter();
      expect(platform.has("voice")).toBe(false);
      expect(platform.device.capabilities.voice).toBe(false);
    });

    it("advertises voice once the bridge has it", () => {
      addVoice();
      const platform = createAospAdapter();
      expect(platform.has("voice")).toBe(true);
      expect(platform.device.capabilities.voice).toBe(true);
    });

    it("reports the end of an attempt that produced no transcript", () => {
      // This is what left the UI listening forever: native emits `stopped` for a
      // no-match, a timeout and an error alike, and the adapter used to drop it,
      // so the only signal a caller ever got was a transcript that never came.
      addVoice();
      const platform = createAospAdapter();
      let ends = 0;
      platform.voice!.onListeningEnd!(() => { ends++; });
      fire({ type: "error", message: "didn't catch that" });
      fire({ type: "stopped" });
      expect(ends).toBe(1);
    });

    it("reports the end after a successful transcript too", () => {
      addVoice();
      const platform = createAospAdapter();
      let ends = 0;
      platform.voice!.onListeningEnd!(() => { ends++; });
      fire({ type: "transcript", text: "mute", isFinal: true });
      fire({ type: "stopped" });
      expect(ends).toBe(1);
    });

    it("stops reporting once unsubscribed", () => {
      addVoice();
      const platform = createAospAdapter();
      let ends = 0;
      const off = platform.voice!.onListeningEnd!(() => { ends++; });
      fire({ type: "stopped" });
      off();
      fire({ type: "stopped" });
      expect(ends).toBe(1);
    });

    it("delivers partial and final transcripts to subscribers", () => {
      addVoice();
      const platform = createAospAdapter();
      const seen: Array<[string, boolean]> = [];
      platform.voice!.onTranscript((text, isFinal) => seen.push([text, isFinal]));
      fire({ type: "transcript", text: "set vol", isFinal: false });
      fire({ type: "transcript", text: "set volume to 30", isFinal: true });
      expect(seen).toEqual([["set vol", false], ["set volume to 30", true]]);
    });

    it("stops delivering after unsubscribe", () => {
      addVoice();
      const platform = createAospAdapter();
      let n = 0;
      const off = platform.voice!.onTranscript(() => { n++; });
      fire({ type: "transcript", text: "a", isFinal: true });
      off();
      fire({ type: "transcript", text: "b", isFinal: true });
      expect(n).toBe(1);
    });

    it("shares one recognizer between several listeners", () => {
      // Android allows only one at a time, so the agent and the avatar can't each
      // open their own.
      addVoice();
      const platform = createAospAdapter();
      const hits: string[] = [];
      platform.voice!.onTranscript(() => hits.push("a"));
      platform.voice!.onTranscript(() => hits.push("b"));
      fire({ type: "transcript", text: "x", isFinal: true });
      expect(hits).toEqual(["a", "b"]);
    });

    it("asks for the microphone when it isn't granted yet", async () => {
      const { calls, denyStt } = addVoice();
      denyStt();
      await createAospAdapter().voice!.startListening();
      expect(calls).toEqual(["requestMicPermission", "startListening"]);
    });

    it("doesn't ask again once granted", async () => {
      const { calls } = addVoice();
      await createAospAdapter().voice!.startListening();
      expect(calls).toEqual(["startListening"]);
    });

    it("resolves speak() when the TV has actually stopped talking", async () => {
      // This is what drives the avatar's mouth, so resolving early would leave it
      // moving after the sound ended.
      const { calls } = addVoice();
      const platform = createAospAdapter();
      let done = false;
      const speaking = platform.voice!.speak("Done.").then(() => { done = true; });
      expect(calls).toEqual(["speak:Done."]);
      expect(done).toBe(false);
      fire({ type: "speakDone", spoken: true });
      await speaking;
      expect(done).toBe(true);
    });

    it("resolves speak() even when the engine couldn't say it", async () => {
      // Otherwise the avatar sticks in the speaking state on a device with no
      // working TTS engine.
      addVoice();
      const platform = createAospAdapter();
      const speaking = platform.voice!.speak("hello");
      fire({ type: "speakDone", spoken: false });
      await expect(speaking).resolves.toBeUndefined();
    });

    it("logs a recognition error instead of throwing", () => {
      // "didn't catch that" is a normal outcome and must not break a turn.
      addVoice();
      createAospAdapter();
      expect(() => fire({ type: "error", message: "didn't catch that" })).not.toThrow();
    });

    it("ignores event types it doesn't know", () => {
      // Native may be newer than the bundle.
      addVoice();
      createAospAdapter();
      expect(() => fire({ type: "somethingNew" })).not.toThrow();
    });
  });
});
