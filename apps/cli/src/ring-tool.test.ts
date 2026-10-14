import { describe, expect, it } from "vitest";
import type { RingState, StatusRing } from "@hearthkit/adapter-linux";
import { parseArgs } from "./args.js";
import { RING_STORY, runRingTool } from "./ring-tool.js";

function ringAndIo() {
  const shown: RingState[] = [];
  const out: string[] = [];
  const ring: StatusRing = { show: async (s) => { shown.push(s); }, off: async () => { shown.push("off"); } };
  return { shown, out, ring, io: { out: (t: string) => { out.push(t); }, err: (t: string) => { out.push(t); } } };
}

describe("hearth ring", () => {
  it("is parsed as a subcommand with its words", () => {
    expect(parseArgs(["ring", "demo"])).toMatchObject({ ringTool: ["demo"], commands: [] });
  });

  it("demo walks every state in order, says what each means, and ends dark", async () => {
    const t = ringAndIo();
    const slept: number[] = [];
    expect(await runRingTool(["demo"], t.io, { ring: t.ring, sleep: async (ms) => { slept.push(ms); }, stepMs: 3_000 })).toBe(0);
    expect(t.shown).toEqual([...RING_STORY.map(([s]) => s), "off"]);
    expect(slept).toEqual(RING_STORY.map(() => 3_000));
    expect(t.out.join("")).toMatch(/moving means work is happening; still means nothing is/i);
    expect(t.out.join("")).toMatch(/ready — dim blue, STILL/);
    expect(t.out.join("")).toMatch(/verified — GREEN, still/);
  });

  it("the story names the still states as still and the working ones as moving", () => {
    const text = (s: RingState) => RING_STORY.find(([x]) => x === s)![1];
    for (const s of ["listening", "verified", "unverified", "unsupported", "failed"] as const) expect(text(s), s).toMatch(/still/i);
    for (const s of ["loading", "recognizing", "thinking", "acting"] as const) expect(text(s), s).toMatch(/going round|tail/);
    for (const s of ["hearing", "speaking"] as const) expect(text(s), s).toMatch(/breathing/);
  });

  it("shows one state and holds it until interrupted, then puts the ring out", async () => {
    const t = ringAndIo();
    expect(await runRingTool(["thinking"], t.io, { ring: t.ring, interrupted: Promise.resolve() })).toBe(0);
    expect(t.shown).toEqual(["thinking", "off"]);
    expect(t.out.join("")).toMatch(/thinking \(moving/);
  });

  it("says what is wrong, and exits 1, when the ring cannot be driven", async () => {
    const t = ringAndIo();
    const broken: StatusRing = { show: async () => { throw new Error("cannot switch the LED power on GPIO5"); }, off: async () => {} };
    expect(await runRingTool(["demo"], t.io, { ring: broken, sleep: async () => {} })).toBe(1);
    expect(t.out.join("")).toMatch(/cannot drive the ring: cannot switch the LED power on GPIO5/);
  });

  it("off, and an unknown word", async () => {
    const t = ringAndIo();
    expect(await runRingTool(["off"], t.io, { ring: t.ring })).toBe(0);
    expect(t.shown).toEqual(["off"]);
    const u = ringAndIo();
    expect(await runRingTool(["sparkle"], u.io, { ring: u.ring })).toBe(2);
    expect(u.out.join("")).toMatch(/states: listening, loading/);
  });
});
