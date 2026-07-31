import { describe, it, expect } from "vitest";
import { runDemo, demoFromUrl, DEFAULT_DEMO_SCRIPT } from "./demo.js";

/** No real waiting; just record that a pause happened. */
const fakeSleep = (log: number[]) => async (ms: number) => { log.push(ms); };

describe("runDemo", () => {
  it("runs every command in order", async () => {
    const ran: string[] = [];
    await runDemo(async (c) => { ran.push(c); }, ["a", "b", "c"], { sleep: fakeSleep([]) });
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("pauses between commands but not after the last one", async () => {
    const pauses: number[] = [];
    await runDemo(async () => {}, ["a", "b", "c"], { pauseMs: 1000, sleep: fakeSleep(pauses) });
    expect(pauses).toEqual([1000, 1000]);
  });

  it("announces each command before running it, with its position", async () => {
    const seen: Array<[string, number, number]> = [];
    const order: string[] = [];
    await runDemo(
      async (c) => { order.push(`run:${c}`); },
      ["a", "b"],
      { sleep: fakeSleep([]), onCommand: (c, i, n) => { seen.push([c, i, n]); order.push(`show:${c}`); } },
    );
    expect(seen).toEqual([["a", 0, 2], ["b", 1, 2]]);
    // The label must appear before the command runs, or the screen lags reality.
    expect(order).toEqual(["show:a", "run:a", "show:b", "run:b"]);
  });

  it("keeps going when a command fails", async () => {
    // Something is always unsupported on a real device; a demo that stops at the
    // first failure is worse than one that moves on.
    const ran: string[] = [];
    await runDemo(
      async (c) => { ran.push(c); if (c === "b") throw new Error("not supported"); },
      ["a", "b", "c"],
      { sleep: fakeSleep([]) },
    );
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("signals completion", async () => {
    let done = 0;
    await runDemo(async () => {}, ["a"], { sleep: fakeSleep([]), onDone: () => { done++; } });
    expect(done).toBe(1);
  });

  it("loops until cancelled", async () => {
    const ran: string[] = [];
    let rounds = 0;
    await runDemo(
      async (c) => { ran.push(c); },
      ["a", "b"],
      { sleep: fakeSleep([]), loop: true, onDone: () => { rounds++; }, cancelled: () => rounds >= 3 },
    );
    expect(rounds).toBe(3);
    expect(ran).toEqual(["a", "b", "a", "b", "a", "b"]);
  });

  it("stops mid-script once cancelled", async () => {
    const ran: string[] = [];
    let stop = false;
    await runDemo(
      async (c) => { ran.push(c); if (c === "b") stop = true; },
      ["a", "b", "c", "d"],
      { sleep: fakeSleep([]), cancelled: () => stop },
    );
    expect(ran).toEqual(["a", "b"]);
  });

  it("uses the built-in script by default", async () => {
    const ran: string[] = [];
    await runDemo(async (c) => { ran.push(c); }, undefined, { sleep: fakeSleep([]) });
    expect(ran).toEqual([...DEFAULT_DEMO_SCRIPT]);
  });
});

describe("DEFAULT_DEMO_SCRIPT", () => {
  it("leaves the TV unmuted — a demo shouldn't hand back a silent set", () => {
    expect(DEFAULT_DEMO_SCRIPT[DEFAULT_DEMO_SCRIPT.length - 1]).toBe("unmute");
    expect(DEFAULT_DEMO_SCRIPT.indexOf("mute")).toBeLessThan(DEFAULT_DEMO_SCRIPT.indexOf("unmute"));
  });

  it("shows off more than one language", () => {
    expect(DEFAULT_DEMO_SCRIPT.some((c) => /[一-鿿]/.test(c))).toBe(true);
    expect(DEFAULT_DEMO_SCRIPT.some((c) => /[぀-ゟ゠-ヿ]/.test(c))).toBe(true);
  });
});

describe("demoFromUrl", () => {
  it("is off unless ?demo is present", () => {
    expect(demoFromUrl("")).toBeUndefined();
    expect(demoFromUrl("?ask=mute")).toBeUndefined();
  });

  it("uses the built-in script for a bare ?demo", () => {
    expect(demoFromUrl("?demo")).toEqual({ commands: DEFAULT_DEMO_SCRIPT, loop: false });
  });

  it("repeats for ?demo=loop", () => {
    expect(demoFromUrl("?demo=loop")?.loop).toBe(true);
  });

  it("lets ?ask= override the script", () => {
    expect(demoFromUrl("?demo&ask=mute&ask=unmute")).toEqual({
      commands: ["mute", "unmute"], loop: false,
    });
  });
});
