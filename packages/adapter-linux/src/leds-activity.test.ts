import { describe, expect, it } from "vitest";
import {
  ANIMATED_STATES, createStatusRing, OUTCOME_STATES, RING_COLOURS, ringFrame, type RingState,
} from "./leds.js";
import { manualScheduler } from "./leds-test-kit.js";
import type { Runner } from "./run.js";

const run: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
const settle = () => new Promise((r) => setTimeout(r, 0));

function recorder() {
  const frames: Uint8Array[] = [];
  return { frames, write: async (_d: string, bytes: Uint8Array) => { frames.push(bytes); } };
}

/** Which LEDs are lit in a written frame. */
const lit = (frame: Uint8Array, count: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (frame[4 + i * 4 + 1]! + frame[4 + i * 4 + 2]! + frame[4 + i * 4 + 3]! > 0) out.push(i);
  return out;
};
/** r, g, b of the first LED in a written frame. */
const colourOf = (rec: ReturnType<typeof recorder>) => { const f = rec.frames.at(-1)!; return [f[7], f[6], f[5]]; };

describe("the moving states", () => {
  it("every state has its own colour, the moving ones included", () => {
    const seen = Object.values(RING_COLOURS).map((c) => c.join(","));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("only the working states move; rest and answers are still", () => {
    expect([...ANIMATED_STATES].sort()).toEqual(["acting", "error", "hearing", "loading", "recognizing", "speaking", "thinking"]);
    for (const still of ["off", "listening", ...OUTCOME_STATES] as RingState[]) expect(ringFrame(still, 3, 12), still).toBeUndefined();
  });

  it("loading is one dot going round", () => {
    const at = (tick: number) => ringFrame("loading", tick, 12)!.map((p, i) => (p.some((v) => v > 0) ? i : -1)).filter((i) => i >= 0);
    expect(at(0)).toEqual([0]);
    expect(at(1)).toEqual([1]);
    expect(at(12)).toEqual([0]);                     // all the way round
  });

  it("a chase has a head, a fading tail behind it, and the direction can be read", () => {
    const f = ringFrame("thinking", 5, 12)!;
    const level = (i: number) => f[i]![0];
    expect(level(5)).toBeGreaterThan(level(4));        // head brightest, brightness falls behind it
    expect(level(4)).toBeGreaterThan(level(3));
    expect(level(6)).toBe(0);                           // nothing ahead of the head
    expect(ringFrame("acting", 1, 12)![2]![2]).toBeGreaterThan(0);   // acting moves two LEDs a tick
  });

  it("breathing swells and fades, and never goes fully dark", () => {
    const levels = Array.from({ length: 24 }, (_, t) => ringFrame("hearing", t, 12)![0]![2]);
    expect(Math.max(...levels)).toBeGreaterThan(Math.min(...levels) * 2);
    expect(Math.min(...levels)).toBeGreaterThan(0);
  });

  it("error blinks", () => {
    expect(ringFrame("error", 0, 12)![0]).not.toEqual([0, 0, 0]);
    expect(ringFrame("error", 5, 12)![0]).toEqual([0, 0, 0]);
  });
});

describe("a ring at rest does not move", () => {
  it("starts no timer for the ready state, or for an answer's colour", async () => {
    const sched = manualScheduler();
    const ring = createStatusRing({ run, write: recorder().write, scheduler: sched });
    await ring.show("listening");
    expect(sched.moving()).toBe(0);
    await ring.show("verified");
    expect(sched.moving()).toBe(0);
  });

  it("paints a new frame on every tick while it works, and stops painting the moment it stops", async () => {
    const sched = manualScheduler();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, scheduler: sched, count: 12 });
    await ring.show("thinking");
    expect(sched.moving()).toBe(1);
    const first = lit(rec.frames.at(-1)!, 12);
    sched.frame(3); await settle();
    expect(rec.frames).toHaveLength(4);
    expect(lit(rec.frames.at(-1)!, 12)).not.toEqual(first);          // it moved

    await ring.show("listening");
    expect(sched.moving()).toBe(0);                                   // and then it is still
    const painted = rec.frames.length;
    sched.frame(5); await settle();
    expect(rec.frames).toHaveLength(painted);
  });

  it("a new working state replaces the old one instead of running beside it", async () => {
    const sched = manualScheduler();
    const ring = createStatusRing({ run, write: recorder().write, scheduler: sched });
    await ring.show("hearing");
    await ring.show("recognizing");
    await ring.show("thinking");
    expect(sched.moving()).toBe(1);
  });

  it("works at the moving brightness: above ready, below an answer", async () => {
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, scheduler: manualScheduler(), count: 1, brightness: 10, idleBrightness: 3, animBrightness: 6 });
    await ring.show("thinking");
    expect(rec.frames.at(-1)![4]).toBe(0xe0 | 6);
  });

  it("goes dark and silent on off, with no timer left running", async () => {
    const sched = manualScheduler();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, scheduler: sched, count: 2 });
    await ring.show("thinking");
    await ring.off();
    expect(sched.moving()).toBe(0);
    expect(lit(rec.frames.at(-1)!, 2)).toEqual([]);
  });

  it("says once, and stops moving, if a frame cannot be written — not an unhandled rejection in a timer", async () => {
    const sched = manualScheduler();
    const errors: unknown[] = [];
    let n = 0;
    const ring = createStatusRing({
      run, scheduler: sched, onError: (e) => errors.push(e),
      write: async () => { if (++n > 1) throw new Error("spidev: device busy"); },
    });
    await ring.show("thinking");
    sched.frame(4); await settle();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("spidev: device busy");
  });
});

describe("an answer is held so it can be read", () => {
  it("keeps the answer's colour when the voice loop immediately asks for the ready state", async () => {
    const sched = manualScheduler();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, scheduler: sched, count: 1, holdMs: 2_500 });
    await ring.show("verified");
    await ring.show("listening");                       // what listenForever does next
    expect(colourOf(rec)).toEqual([...RING_COLOURS.verified]);

    sched.advance(2_499); await settle();
    expect(colourOf(rec)).toEqual([...RING_COLOURS.verified]);
    sched.advance(1); await settle();
    expect(colourOf(rec)).toEqual([...RING_COLOURS.listening]);       // settled, and still
    expect(sched.moving()).toBe(0);
  });

  it("settles to ready by itself when nothing follows", async () => {
    const sched = manualScheduler();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, scheduler: sched, count: 1 });
    await ring.show("failed");
    sched.advance(2_500); await settle();
    expect(colourOf(rec)).toEqual([...RING_COLOURS.listening]);
  });

  it("starts the waiting state when the hold ends, so work that began during an answer is not lost", async () => {
    const sched = manualScheduler();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, scheduler: sched, count: 12 });
    await ring.show("verified");
    await ring.show("thinking");                        // arrives during the hold
    expect(sched.moving()).toBe(0);
    sched.advance(2_500); await settle();
    expect(sched.moving()).toBe(1);                     // now it moves
  });

  it("lets a newer answer take over at once", async () => {
    const sched = manualScheduler();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, scheduler: sched, count: 1 });
    await ring.show("verified");
    await ring.show("failed");
    expect(colourOf(rec)).toEqual([...RING_COLOURS.failed]);
  });

  it("off is never deferred", async () => {
    const sched = manualScheduler();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, scheduler: sched, count: 2 });
    await ring.show("verified");
    await ring.show("off");
    expect(lit(rec.frames.at(-1)!, 2)).toEqual([]);
  });
});
