import { describe, it, expect, vi } from "vitest";
import { isTvUnsupported } from "@hearthkit/platform-api";
import { apa102Frame, createStatusRing, RING_COLOURS } from "./leds.js";
import type { Runner } from "./run.js";

function fakeRunner(code = 0, stderr = ""): Runner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    return { code, stdout: "", stderr };
  }) as Runner & { calls: string[] };
  run.calls = calls;
  return run;
}

function recorder() {
  const frames: Uint8Array[] = [];
  return {
    frames,
    write: async (_dev: string, bytes: Uint8Array) => { frames.push(bytes); },
  };
}

describe("the APA102 wire format", () => {
  it("writes brightness, then blue, green, red — in that order", () => {
    // The order that surprises everyone exactly once. A red pixel written as if
    // it were RGB comes out blue, which looks like a colour choice rather than a
    // bug and so survives review.
    const frame = apa102Frame([[255, 0, 0]], 10);
    expect([...frame.subarray(4, 8)]).toEqual([0xe0 | 10, 0, 0, 255]);
  });

  it("opens with a zero frame and closes with ones", () => {
    const frame = apa102Frame([[1, 2, 3], [4, 5, 6]], 31);
    expect([...frame.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    // One bit per two LEDs, with four bytes as the floor every implementation
    // agrees on — the last pixel does not latch without it.
    expect([...frame.subarray(4 + 2 * 4)]).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it("keeps brightness inside the five bits it has", () => {
    expect(apa102Frame([[0, 0, 0]], 99)[4]).toBe(0xff);
    expect(apa102Frame([[0, 0, 0]], -5)[4]).toBe(0xe0);
  });
});

describe("the four honest answers have four different colours", () => {
  it("does not show unverified as verified", () => {
    // The whole reason this ring exists. Green for "nothing could confirm it"
    // would be the same lie in hardware that `execute -> assume success` is in
    // software.
    expect(RING_COLOURS.unverified).not.toEqual(RING_COLOURS.verified);
  });

  it("does not show unsupported as failed", () => {
    // A failure invites a retry. An absent capability can never succeed, however
    // many times it is asked, so it must not wear the colour that says try again.
    expect(RING_COLOURS.unsupported).not.toEqual(RING_COLOURS.failed);
  });

  it("gives every state a colour of its own", () => {
    const seen = Object.values(RING_COLOURS).map((c) => c.join(","));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("the status ring", () => {
  it("powers the gate before writing, not after", async () => {
    // Writing first succeeds and shows nothing: the strip has no power yet, and
    // spidev reports a perfectly good write either way. That is how an evening
    // gets spent on SPI clock rates that were never the problem.
    const run = fakeRunner();
    const rec = recorder();
    const order: string[] = [];
    const ring = createStatusRing({
      run: (async (cmd: string, args: string[]) => {
        order.push("power");
        return run(cmd, args);
      }) as Runner,
      write: async (dev, bytes) => { order.push("write"); await rec.write(dev, bytes); },
    });

    await ring.show("listening");
    expect(order).toEqual(["power", "write"]);
    expect(run.calls).toEqual(["pinctrl set 5 op dh"]);
  });

  it("paints every LED the colour of the state", async () => {
    const rec = recorder();
    const ring = createStatusRing({ run: fakeRunner(), write: rec.write, count: 3, brightness: 10 });

    await ring.show("unverified");
    const [r, g, b] = RING_COLOURS.unverified;
    const frame = rec.frames.at(-1)!;
    for (let i = 0; i < 3; i++) {
      expect([...frame.subarray(4 + i * 4, 8 + i * 4)]).toEqual([0xe0 | 10, b, g, r]);
    }
  });

  it("listens dimly and answers at full brightness", async () => {
    // Listening is the state the room sees all evening; an outcome is the
    // state it is meant to notice. About 10% versus the normal level.
    const rec = recorder();
    const ring = createStatusRing({ run: fakeRunner(), write: rec.write, count: 1, brightness: 10 });
    await ring.show("listening");
    expect(rec.frames.at(-1)![4]).toBe(0xe0 | 3);
    await ring.show("verified");
    expect(rec.frames.at(-1)![4]).toBe(0xe0 | 10);
    const custom = createStatusRing({ run: fakeRunner(), write: rec.write, count: 1, idleBrightness: 1 });
    await custom.show("listening");
    expect(rec.frames.at(-1)![4]).toBe(0xe0 | 1);
  });

  it("goes dark and then drops the power rail", async () => {
    const run = fakeRunner();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, count: 2 });

    await ring.show("verified");
    await ring.off();

    // Black pixels first, power off second: cutting power with a colour still
    // latched leaves the ring bright for as long as the capacitors hold.
    const last = rec.frames.at(-1)!;
    expect([...last.subarray(4, 12)]).toEqual([0xe0 | 10, 0, 0, 0, 0xe0 | 10, 0, 0, 0]);
    expect(run.calls).toEqual(["pinctrl set 5 op dh", "pinctrl set 5 op dl"]);
  });

  it("does not toggle the power rail it has already set", async () => {
    const run = fakeRunner();
    const ring = createStatusRing({ run, write: recorder().write });
    await ring.show("listening");
    await ring.show("thinking");
    await ring.show("verified");
    expect(run.calls).toEqual(["pinctrl set 5 op dh"]);
  });

  it("reports a board with no power control as unsupported, naming the pin", async () => {
    const ring = createStatusRing({
      run: fakeRunner(127, "pinctrl: command not found"),
      write: recorder().write,
    });
    await expect(ring.show("failed")).rejects.toSatisfy(isTvUnsupported);
    await expect(ring.show("failed")).rejects.toThrow(/GPIO5.*command not found/s);
  });

  it("leaves the power alone on a board whose LEDs are always live", async () => {
    const run = fakeRunner();
    const rec = recorder();
    const ring = createStatusRing({ run, write: rec.write, powerPin: undefined as unknown as number });
    await ring.show("verified");
    expect(rec.frames).toHaveLength(1);
  });

  it("writes to CS1, where the ring actually is", async () => {
    const write = vi.fn(async () => {});
    const ring = createStatusRing({ run: fakeRunner(), write });
    await ring.show("thinking");
    // `/dev/spidev0.0` is the one a first guess reaches for, and it is the wrong
    // chip select — the ring is on CS1, as the vendor's own driver opens it.
    expect(write.mock.calls[0]![0]).toBe("/dev/spidev0.1");
  });
});
