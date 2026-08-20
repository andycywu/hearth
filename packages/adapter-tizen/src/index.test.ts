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
