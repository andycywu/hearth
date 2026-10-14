/**
 * Test helpers for the status ring: a clock and two kinds of timer that a test turns by hand, so an
 * animation can be stepped frame by frame and an answer's hold can be run out without waiting.
 * Not exported from the package.
 */
import type { RingScheduler } from "./leds.js";

export interface ManualScheduler extends RingScheduler {
  /** Move the clock on, firing any `after` timer that comes due. */
  advance(ms: number): void;
  /** Fire every running `every` timer, `n` times. */
  frame(n?: number): void;
  /** How many `every` timers are running — zero means nothing on the ring is moving. */
  moving(): number;
}

export function manualScheduler(): ManualScheduler {
  let t = 0;
  const every: Array<{ fn: () => void; live: boolean }> = [];
  const after: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    now: () => t,
    every: (_ms, fn) => { const h = { fn, live: true }; every.push(h); return () => { h.live = false; }; },
    after: (ms, fn) => { const h = { at: t + ms, fn, live: true }; after.push(h); return () => { h.live = false; }; },
    advance(ms) { t += ms; for (const h of after) if (h.live && h.at <= t) { h.live = false; h.fn(); } },
    frame(n = 1) { for (let i = 0; i < n; i++) for (const h of every) if (h.live) h.fn(); },
    moving: () => every.filter((h) => h.live).length,
  };
}
