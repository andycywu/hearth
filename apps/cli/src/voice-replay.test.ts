import { describe, it, expect } from "vitest";
import type { InputSource, ScreenLayout } from "@hearthkit/platform-api";
import type { TvModule } from "./tv-module.js";
import { heardCommand, judge, readTvState, restoreTvState, type ReplayRun } from "./voice-replay.js";

// Trace lines as voice-loop.ts and local-listener.ts write them.
const HEARD = ["  🎤 (not sent: silence, 900 ms, rms 0.0031)", "  🎤 小爐小爐 小聲一點"];
const run = (over: Partial<ReplayRun> = {}): ReplayRun => ({ trace: HEARD, output: "Done.\n", finished: true, ...over });

describe("heardCommand", () => {
  it("takes the first line that passed the wake word, and not the dropped windows before it", () => {
    expect(heardCommand(HEARD)).toBe("小爐小爐 小聲一點");
  });
  it("leaves out the alias note", () => {
    expect(heardCommand(['  🎤 harth turn it down   (taken as "hearth": heard "harth")'])).toBe("harth turn it down");
  });
  it("answers undefined when everything was not for us", () => {
    expect(heardCommand(["  🎤 (not for me) 今天天氣"])).toBeUndefined();
  });
});

describe("judge", () => {
  it("is verified only when the television reads back what was asked", () => {
    const v = judge({ volume: "down" }, { volume: 23 }, { volume: 18 }, run());
    expect(v.status).toBe("verified");
    expect(v.checks.map((c) => c.what)).toEqual(["heard", "volume"]);
  });

  it("fails when the television did not move, however confident the answer was", () => {
    const v = judge({ volume: "down" }, { volume: 23 }, { volume: 23 }, run({ output: "I turned it down.\n" }));
    expect(v.status).toBe("failed");
    expect(v.checks[1]).toMatchObject({ what: "volume", status: "failed", detail: "23 → 23 (wanted down)" });
  });

  it("allows the slack of the television's own volume scale for a number", () => {
    expect(judge({ volume: 20 }, { volume: 5 }, { volume: 18 }, run()).status).toBe("verified");
    expect(judge({ volume: 20 }, { volume: 5 }, { volume: 17 }, run()).status).toBe("failed");
  });

  it("is unverified, not verified, when the after-state could not be read", () => {
    expect(judge({ input: "hdmi3" }, { input: "app" }, {}, run()).status).toBe("unverified");
  });

  it("fails with what was heard instead when nothing passed the wake word", () => {
    const v = judge({ mute: true }, { mute: false }, { mute: true }, run({ trace: ["  🎤 (not for me) 小路小路 靜音"] }));
    expect(v.status).toBe("failed");
    expect(v.checks).toHaveLength(1);
    expect(v.checks[0]!.detail).toContain("小路小路");
  });

  it("fills a spoken answer's expected words from the before-state", () => {
    expect(judge({ says: "{volume}" }, { volume: 23 }, { volume: 23 }, run({ output: "The volume is 23.\n" })).status).toBe("verified");
    expect(judge({ says: "{volume}" }, { volume: 23 }, { volume: 23 }, run({ output: "The volume is 40.\n" })).status).toBe("failed");
  });

  it("fails a turn that never ended even when the state happens to match", () => {
    expect(judge({ layout: "panel" }, { layout: "fullscreen" }, { layout: "panel" }, run({ finished: false })).status).toBe("failed");
  });
});

function tv(start: { volume: number; mute: boolean; input: InputSource; layout: ScreenLayout }) {
  const s = { ...start };
  const calls: string[] = [];
  const module: TvModule = {
    system: {
      getVolume: async () => s.volume,
      // As on the set this was written against: a volume change clears mute.
      setVolume: async (v) => { calls.push(`volume ${v}`); s.volume = v; s.mute = false; },
      getMute: async () => s.mute,
      setMute: async (m) => { calls.push(`mute ${m}`); s.mute = m; },
      getInputSource: async () => s.input,
      setInputSource: async (i) => { calls.push(`input ${i}`); s.input = i; },
    },
    display: { getLayout: async () => s.layout, setLayout: async (l) => { calls.push(`layout ${l}`); s.layout = l; } },
  };
  return { module, s, calls };
}

describe("readTvState / restoreTvState", () => {
  it("reads every member the module offers and leaves out one that throws", async () => {
    const t = tv({ volume: 23, mute: false, input: "app", layout: "fullscreen" });
    t.module.system!.getInputSource = async () => { throw new Error("no"); };
    expect(await readTvState(t.module)).toEqual({ volume: 23, mute: false, layout: "fullscreen" });
  });

  it("puts back only what changed, the volume before the mute it would clear", async () => {
    const t = tv({ volume: 20, mute: false, input: "hdmi3", layout: "panel" });
    const before = { volume: 23, mute: true, input: "app" as const, layout: "fullscreen" as const };
    const after = await readTvState(t.module);
    await restoreTvState(t.module, before, after);
    expect(t.calls).toEqual(["layout fullscreen", "input app", "volume 23", "mute true"]);
    expect(await readTvState(t.module)).toEqual(before);
  });

  it("touches nothing when nothing changed", async () => {
    const t = tv({ volume: 23, mute: false, input: "app", layout: "fullscreen" });
    const state = await readTvState(t.module);
    expect(await restoreTvState(t.module, state, state)).toEqual([]);
    expect(t.calls).toEqual([]);
  });
});
