import { describe, it, expect } from "vitest";
import { avatarFrame } from "./avatar.js";
import type { AgentPhase } from "./view-model.js";

const PHASES: AgentPhase[] = ["idle", "listening", "thinking", "speaking"];

/** Sample a phase across time and report the range of a field. */
function range(phase: AgentPhase, pick: (t: number) => number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < 8000; t += 25) {
    const v = pick(t);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

describe("avatarFrame", () => {
  it("is pure — same time, same frame", () => {
    for (const phase of PHASES) {
      expect(avatarFrame(phase, 1234)).toEqual(avatarFrame(phase, 1234));
    }
  });

  it("gives every phase its own colour, so state reads at a glance", () => {
    const colors = PHASES.map((p) => avatarFrame(p, 0).color);
    expect(new Set(colors).size).toBe(PHASES.length);
  });

  it("keeps the core on screen in every phase", () => {
    // Radii are fractions of the available space; over 1 would clip.
    for (const phase of PHASES) {
      const r = range(phase, (t) => avatarFrame(phase, t).coreScale);
      expect(r.min).toBeGreaterThan(0.2);
      expect(r.max).toBeLessThan(0.8);
    }
  });

  it("breathes when idle, but only slightly", () => {
    const r = range("idle", (t) => avatarFrame("idle", t).coreScale);
    expect(r.max - r.min).toBeGreaterThan(0.02);   // visibly alive
    expect(r.max - r.min).toBeLessThan(0.1);       // not attention-seeking
  });

  it("sends rings outward only while listening", () => {
    const listening = avatarFrame("listening", 500);
    expect(listening.rings.length).toBeGreaterThan(0);
    for (const phase of ["idle", "thinking", "speaking"] as AgentPhase[]) {
      expect(avatarFrame(phase, 500).rings).toEqual([]);
    }
  });

  it("always has a ring mid-flight, so listening never looks frozen", () => {
    for (let t = 0; t < 4000; t += 37) {
      const rings = avatarFrame("listening", t).rings;
      const midFlight = rings.filter((p) => p > 0.15 && p < 0.85);
      expect(midFlight.length).toBeGreaterThan(0);
    }
  });

  it("rings travel outward and stay within 0..1", () => {
    const first = avatarFrame("listening", 0).rings[0]!;
    const later = avatarFrame("listening", 400).rings[0]!;
    expect(later).toBeGreaterThan(first);
    for (let t = 0; t < 4000; t += 25) {
      for (const p of avatarFrame("listening", t).rings) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it("spins arcs only while thinking", () => {
    expect(avatarFrame("thinking", 0).arcSweep).toBeGreaterThan(0);
    expect(avatarFrame("thinking", 600).spin).toBeGreaterThan(avatarFrame("thinking", 0).spin);
    for (const phase of ["idle", "listening", "speaking"] as AgentPhase[]) {
      expect(avatarFrame(phase, 600).arcSweep).toBe(0);
    }
  });

  it("moves more, and faster, while speaking than while idle", () => {
    const speak = range("speaking", (t) => avatarFrame("speaking", t).coreScale);
    const idle = range("idle", (t) => avatarFrame("idle", t).coreScale);
    expect(speak.max - speak.min).toBeGreaterThan(idle.max - idle.min);
  });

  it("doesn't wobble like a clean sine while speaking", () => {
    // A single sine reads as mechanical. Two detuned components should make
    // consecutive peaks differ.
    const peaks: number[] = [];
    let prev = -Infinity;
    let rising = true;
    for (let t = 0; t < 4000; t += 8) {
      const v = avatarFrame("speaking", t).coreScale;
      if (rising && v < prev) { peaks.push(prev); rising = false; }
      if (!rising && v > prev) rising = true;
      prev = v;
    }
    expect(peaks.length).toBeGreaterThan(4);
    expect(new Set(peaks.map((p) => p.toFixed(3))).size).toBeGreaterThan(1);
  });

  it("uses a supplied speech level instead of self-driving", () => {
    const quiet = avatarFrame("speaking", 1000, { level: 0 });
    const loud = avatarFrame("speaking", 1000, { level: 1 });
    expect(loud.coreScale).toBeGreaterThan(quiet.coreScale);
    expect(loud.glow).toBeGreaterThan(quiet.glow);
  });

  it("clamps an out-of-range level rather than drawing off screen", () => {
    const over = avatarFrame("speaking", 0, { level: 5 });
    const under = avatarFrame("speaking", 0, { level: -5 });
    expect(over.coreScale).toBeLessThan(0.8);
    expect(under.coreScale).toBeGreaterThan(0.2);
    expect(over.glow).toBeLessThanOrEqual(1);
  });

  describe("reduced motion", () => {
    it("holds every phase completely still", () => {
      for (const phase of PHASES) {
        const a = avatarFrame(phase, 0, { reducedMotion: true });
        const b = avatarFrame(phase, 9999, { reducedMotion: true });
        expect(a).toEqual(b);
      }
    });

    it("still distinguishes the phases — colour and shape, not motion", () => {
      const frames = PHASES.map((p) => avatarFrame(p, 0, { reducedMotion: true }));
      expect(new Set(frames.map((f) => f.color)).size).toBe(PHASES.length);
      // listening keeps a ring, thinking keeps its arc, so the two "busy" states
      // aren't reduced to colour alone.
      const [, listening, thinking] = frames;
      expect(listening!.rings.length).toBeGreaterThan(0);
      expect(thinking!.arcSweep).toBeGreaterThan(0);
    });
  });
});
