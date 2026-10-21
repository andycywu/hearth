import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertProviderContract } from "@hearthkit/platform-api";
import { createTizenAdapter } from "./index.js";

/** Minimal stand-ins for the on-device `tizen.*` / `webapis.*` globals. */
function installTizenMocks(): void {
  const state = { volume: 20, muted: false };
  const apps = [
    { id: "org.tizen.netflix", name: "Netflix", version: "1.0" },
    { id: "org.tizen.youtube", name: "YouTube", version: "1.0" },
  ];
  const first = apps[0]!;
  (globalThis as any).tizen = {
    application: {
      getAppsInfo: (ok: (l: any[]) => void) => ok(apps),
      launch: (_id: string, ok: () => void) => ok(),
      getCurrentApplication: () => ({ appInfo: { id: first.id, name: first.name } }),
    },
  };
  (globalThis as any).webapis = {
    audiocontrol: {
      getVolume: () => state.volume,
      setVolume: (l: number) => { state.volume = Math.max(0, Math.min(100, Math.round(l))); },
      getMute: () => state.muted,
      setMute: (m: boolean) => { state.muted = m; },
    },
    productinfo: { getVersion: () => "7.0", getModel: () => "MTK-Tizen-ref" },
    network: { isConnectedToGateway: () => true, getActiveConnectionType: () => 1 },
    tvinfo: { getCurrentSource: () => 0 },
  };
}

describe("adapter-tizen", () => {
  beforeEach(() => installTizenMocks());
  afterEach(() => {
    delete (globalThis as any).tizen;
    delete (globalThis as any).webapis;
  });

  it("satisfies the provider contract via mocked Tizen Web APIs", async () => {
    await assertProviderContract(() => createTizenAdapter());
  });

  it("detects MediaTek SoC from the model string", async () => {
    const p = createTizenAdapter();
    if (p.device.soc !== "mediatek") {
      throw new Error(`expected mediatek, got ${p.device.soc}`);
    }
  });

  it("falls back to the standard tizen.tvaudiocontrol when Samsung's is absent", async () => {
    // The TV emulator has no proprietary webapis at all — verified there. A TV
    // agent that can't change the volume on such a build is useless, so the
    // standard API has to carry it.
    delete (globalThis as any).webapis;
    let level = 7;
    (globalThis as any).tizen.tvaudiocontrol = {
      getVolume: () => level,
      setVolume: (v: number) => { level = v; },
      setMute: () => {},
    };
    const p = createTizenAdapter();
    expect(await p.system.getVolume()).toBe(7);
    await p.system.setVolume(33);
    expect(await p.system.getVolume()).toBe(33);
  });

  it("reads mute through isMute() on the standard API, which has no getMute()", async () => {
    // The two APIs disagree on this one name and on no other, which is why it
    // survived: Samsung's webapis.audiocontrol answers getMute(), the standard
    // tizen.tvaudiocontrol answers isMute() and has no getMute at all. Asking
    // the wrong one is a TypeError — a *failure* from a television that can
    // answer perfectly well. Shaped after the real object, read off an HKC
    // Tizen 7.0 set on 2026-09-14: setMute, isMute, setVolume, setVolumeUp,
    // setVolumeDown, getVolume, ... and no getMute.
    delete (globalThis as any).webapis;
    let muted = true;
    (globalThis as any).tizen.tvaudiocontrol = {
      getVolume: () => 15,
      setVolume: () => {},
      setMute: (m: boolean) => { muted = m; },
      isMute: () => muted,
    };
    const p = createTizenAdapter();
    expect(await p.system.getMute()).toBe(true);
    await p.system.setMute(false);
    expect(await p.system.getMute()).toBe(false);
  });

  it("says so when an audio API has neither spelling of the mute read", async () => {
    delete (globalThis as any).webapis;
    (globalThis as any).tizen.tvaudiocontrol = { getVolume: () => 1, setVolume: () => {} };
    await expect(createTizenAdapter().system.getMute())
      .rejects.toThrow(/neither getMute\(\).*nor isMute\(\)/s);
  });

  it("names both APIs when neither exists, rather than a TypeError", async () => {
    // "cannot read property of undefined" tells you nothing from a TV you can't
    // attach a debugger to; ?diag surfaces this sentence verbatim.
    delete (globalThis as any).webapis;
    delete (globalThis as any).tizen.tvaudiocontrol;
    const p = createTizenAdapter();
    await expect(p.system.getVolume()).rejects.toThrow(/no audio control API.*\$WEBAPIS.*tvaudiocontrol/s);
  });

  it("fills device info from standard tizen.systeminfo when webapis is absent", async () => {
    // Otherwise the status line reads "unknown · tizen unknown · soc=unknown",
    // which is what the emulator showed.
    delete (globalThis as any).webapis;
    (globalThis as any).tizen.systeminfo = {
      getPropertyValue: (prop: string, ok: (v: unknown) => void) => {
        if (prop === "BUILD") ok({ model: "NVT-Tizen-ref", buildVersion: "10.0" });
      },
    };
    const p = createTizenAdapter();
    await p.init();
    expect(p.device.model).toBe("NVT-Tizen-ref");
    expect(p.device.osVersion).toBe("10.0");
    expect(p.device.soc).toBe("novatek");
  });

  it("prefers Samsung's numbers when both are available", async () => {
    (globalThis as any).tizen.systeminfo = {
      getPropertyValue: (prop: string, ok: (v: unknown) => void) => {
        if (prop === "BUILD") ok({ model: "generic", buildVersion: "10.0" });
      },
    };
    const p = createTizenAdapter();
    await p.init();
    expect(p.device.model).toBe("MTK-Tizen-ref");   // from the webapis mock
    expect(p.device.soc).toBe("mediatek");
  });

  it("doesn't claim to be online just because it can't tell", async () => {
    // The emulator reported "isOnline: true" while every fetch failed. The
    // agent uses this to decide whether to try the model, so a confident wrong
    // answer is worse than a cautious one.
    delete (globalThis as any).webapis;
    // `navigator` is a getter-only global in Node, so swap the descriptor.
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
    try {
      expect(await createTizenAdapter().network.isOnline()).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete (globalThis as any).navigator;
    }
  });

  it("reports what the TV itself says its network is", async () => {
    // Standard Tizen, so this is the truth on a build with no Samsung webapis —
    // where connectionType used to flatly answer "none" whatever was going on.
    delete (globalThis as any).webapis;
    (globalThis as any).tizen.systeminfo = {
      getPropertyValue: (prop: string, ok: (v: unknown) => void) => {
        if (prop === "NETWORK") ok({ networkType: "ETHERNET" });
      },
    };
    const p = createTizenAdapter();
    expect(await p.network.connectionType()).toBe("ethernet");
    expect(await p.network.isOnline()).toBe(true);
  });

  it("believes the TV when it says it has no network", async () => {
    delete (globalThis as any).webapis;
    (globalThis as any).tizen.systeminfo = {
      getPropertyValue: (prop: string, ok: (v: unknown) => void) => {
        if (prop === "NETWORK") ok({ networkType: "NONE" });
      },
    };
    const p = createTizenAdapter();
    expect(await p.network.isOnline()).toBe(false);
    expect(await p.network.connectionType()).toBe("none");
  });

  it("still prefers Samsung's gateway check when it exists", async () => {
    (globalThis as any).webapis.network = { isConnectedToGateway: () => false };
    expect(await createTizenAdapter().network.isOnline()).toBe(false);
  });

  it("survives systeminfo being unavailable", async () => {
    delete (globalThis as any).webapis;
    delete (globalThis as any).tizen.systeminfo;
    const p = createTizenAdapter();
    await p.init();   // must not throw — an unnamed TV still has to boot
    expect(p.device.model).toBe("unknown");
  });
});

describe("a build with no audio control API", () => {
  /**
   * Exactly what the Tizen emulator is: neither Samsung's `webapis.audiocontrol`
   * nor the standard `tizen.tvaudiocontrol`. Found by running there — the
   * viewer was told "That didn't work", which invites retrying something that
   * can never work on this firmware.
   */
  beforeEach(() => {
    installTizenMocks();
    delete (globalThis as any).webapis.audiocontrol;
    delete (globalThis as any).tizen.tvaudiocontrol;
  });

  it("reports volume as unsupported, not as a failure", async () => {
    const { isTvUnsupported } = await import("@hearthkit/platform-api");
    await expect(createTizenAdapter().system.getVolume()).rejects.toSatisfy(isTvUnsupported);
  });

  it("says the same about mute instead of confidently answering false", async () => {
    // getMute used to swallow the error and return false, so "is the TV muted?"
    // got a confident "no" from a TV that cannot tell — while getVolume on the
    // very same build threw. One of the two had to be wrong.
    const { isTvUnsupported } = await import("@hearthkit/platform-api");
    await expect(createTizenAdapter().system.getMute()).rejects.toSatisfy(isTvUnsupported);
  });

  it("names both APIs it looked for, since that is the fix", async () => {
    await expect(createTizenAdapter().system.getVolume())
      .rejects.toThrow(/webapis\.audiocontrol.*tizen\.tvaudiocontrol/s);
  });
});

describe("adapter-tizen input source", () => {
  // The shapes are the ones read from the HKC Tizen 7.0 set (tools/experiments/tizen-input-probe/results):
  // getSource('MAIN') is synchronous and returns {type, number}; VIDEOSOURCE lists connected and disconnected.
  const HDMI1 = { type: "HDMI", number: 1 };
  const HDMI3 = { type: "HDMI", number: 3 };
  let current: any;
  let launched: string[];

  function install(over: { setSource?: (s: any, ok: () => void, err: (e: any) => void) => void; connected?: any[]; disconnected?: any[] } = {}): void {
    installTizenMocks();
    current = HDMI3;
    launched = [];
    const t = (globalThis as any).tizen;
    t.application.launch = (id: string, ok: () => void) => { launched.push(id); ok(); };
    t.systeminfo = {
      getPropertyValue: (_p: string, ok: (v: any) => void) =>
        ok({ connected: over.connected ?? [HDMI1], disconnected: over.disconnected ?? [HDMI3] }),
    };
    t.tvwindow = {
      getSource: (_w: string) => current,
      setSource: over.setSource ?? ((s: any, ok: () => void) => { current = s; ok(); }),
    };
  }

  beforeEach(() => { install(); });
  afterEach(() => {
    delete (globalThis as any).tizen;
    delete (globalThis as any).webapis;
  });

  it("reads the input from tizen.tvwindow, not from a constant", async () => {
    expect(await createTizenAdapter().system.getInputSource()).toBe("hdmi3");
    current = HDMI1;
    expect(await createTizenAdapter().system.getInputSource()).toBe("hdmi1");
  });

  it("switches, reads back, and only then brings the viewer up", async () => {
    const p = createTizenAdapter({ input: { showAfterSwitch: { delayMs: 5 } } });
    await p.system.setInputSource("hdmi1");
    expect(current).toBe(HDMI1);
    expect(launched).toEqual([]);                       // the read-back happens before the page is suspended
    await new Promise((r) => setTimeout(r, 30));
    expect(launched).toEqual(["org.tizen.tv-viewer"]);
  });

  it("does not launch the viewer when asked not to", async () => {
    await createTizenAdapter({ input: { showAfterSwitch: false } }).system.setInputSource("hdmi1");
    await new Promise((r) => setTimeout(r, 20));
    expect(launched).toEqual([]);
  });

  it("fails — not verified — when the television says ok and then reports another source", async () => {
    install({ setSource: (_s, ok) => ok() });           // accepted and ignored
    const { isTvUnsupported } = await import("@hearthkit/platform-api");
    const err = await createTizenAdapter({ input: { showAfterSwitch: false } }).system.setInputSource("hdmi1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isTvUnsupported(err)).toBe(false);
    expect(String(err.message)).toMatch(/hdmi1.*reports hdmi3/);
  });

  it("is unsupported when the television does not list the source", async () => {
    const { isTvUnsupported } = await import("@hearthkit/platform-api");
    await expect(createTizenAdapter().system.setInputSource("hdmi4")).rejects.toSatisfy(isTvUnsupported);
  });

  it("is unsupported when the platform refuses with SecurityError", async () => {
    install({ setSource: (_s, _ok, err) => err({ name: "SecurityError", message: "denied" }) });
    const { isTvUnsupported } = await import("@hearthkit/platform-api");
    await expect(createTizenAdapter().system.setInputSource("hdmi1")).rejects.toSatisfy(isTvUnsupported);
  });

  it("is unsupported, and says which privilege, when there is no tvwindow", async () => {
    delete (globalThis as any).tizen.tvwindow;
    const { isTvUnsupported } = await import("@hearthkit/platform-api");
    const p = createTizenAdapter();
    await expect(p.system.getInputSource()).rejects.toSatisfy(isTvUnsupported);
    await expect(p.system.setInputSource("hdmi1")).rejects.toThrow(/tv\.window/);
  });
});
