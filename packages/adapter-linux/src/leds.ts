/**
 * The status ring — four honest answers, in a colour each.
 *
 * A living-room device has a problem no desktop has: the screen is busy. The
 * Raspberry Pi this runs on is plugged into the television's HDMI, and when
 * somebody asks it something the television is very likely showing a film. An
 * answer that requires taking the picture away to deliver it is an answer most
 * people will switch off.
 *
 * So the twelve APA102 LEDs on a ReSpeaker array are not decoration here. They
 * are the one feedback channel that does not interrupt anything, and what they
 * are asked to carry is the distinction this whole runtime is built on:
 *
 *   verified     green    it was done, and a read-back agrees
 *   unverified   amber    it was asked for, and nothing here can confirm it
 *   failed       red      it was attempted and the device is not as expected
 *   unsupported  violet   this device cannot do it at all
 *
 * **`unverified` has its own colour on purpose.** Showing it green would be the
 * same lie in hardware that `execute -> assume success` is in software, and this
 * package exists because that lie is easy to tell. `unsupported` is not red
 * either: a failure invites a retry, and an absent capability can never succeed
 * no matter how many times it is asked.
 *
 * Two hardware facts, both learned the slow way on a Pi 3B:
 *
 * 1. **The LEDs have a power gate on GPIO5** and it is an input — therefore off
 *    — until something drives it high. Perfect data sent to an unpowered strip
 *    looks exactly like sending nothing, and the SPI write still succeeds.
 * 2. **They are on CS1** (`/dev/spidev0.1`), not CS0.
 *
 * Both are driven without a native module: power through `pinctrl` (the same
 * injectable `Runner` every other command in this adapter goes through) and data
 * through a plain write to the spidev character device at its default clock,
 * which a magenta ring confirmed is fast enough.
 */
import { TvUnsupportedError } from "@hearthkit/platform-api";
import { systemRunner, type Runner } from "./run.js";

export type Rgb = readonly [number, number, number];

/**
 * What the ring can say. Four of these are the outcomes a step can have; the
 * other three are the states around them.
 */
export type RingState =
  | "off" | "listening" | "thinking"
  | "verified" | "unverified" | "failed" | "unsupported";

/**
 * Deliberately not a gradient. Someone across a room is reading hue, not
 * brightness, and the four outcomes have to be told apart at a glance by a
 * person who is not looking for them.
 */
export const RING_COLOURS: Record<Exclude<RingState, "off">, Rgb> = {
  listening: [0, 90, 255],
  thinking: [255, 255, 255],
  verified: [0, 255, 60],
  unverified: [255, 140, 0],
  failed: [255, 0, 0],
  unsupported: [150, 0, 255],
};

export interface StatusRingOptions {
  /** 12 on the ReSpeaker 4-Mic Array and the 6-Mic circular; 3 on the 2-Mic HAT. */
  count?: number;
  /** CS1, which is where the ring is — not the `spidev0.0` a first guess reaches for. */
  device?: string;
  /** The power gate. `undefined` for a board whose LEDs are always powered. */
  powerPin?: number;
  /** 0-31. Low by default: this sits in a dark room, not on a desk. */
  brightness?: number;
  /**
   * 0-31, for `listening` only. The ring is in this state almost all the
   * time — every quiet five-second window is another one — so it is the state
   * a person sees out of the corner of their eye for an evening. About 10% of
   * full (3/31) says "awake" without lighting the wall; the outcomes above
   * keep the normal brightness because they are meant to be noticed.
   */
  idleBrightness?: number;
  run?: Runner;
  /** Injected in tests; defaults to writing the bytes to the spidev device. */
  write?: (device: string, bytes: Uint8Array) => Promise<void>;
}

export interface StatusRing {
  show(state: RingState): Promise<void>;
  /** Powers the ring down as well, so an idle device is dark rather than black. */
  off(): Promise<void>;
}

/**
 * The APA102 wire format, as a pure function.
 *
 * Start frame of zeros, one four-byte frame per LED — brightness header then
 * **blue, green, red**, which is the order that surprises everyone once — and an
 * end frame of ones long enough to clock the last pixel down the chain
 * (one bit per two LEDs; four bytes is the floor everything agrees on).
 */
export function apa102Frame(pixels: readonly Rgb[], brightness = 10): Uint8Array {
  const level = 0xe0 | Math.max(0, Math.min(31, Math.round(brightness)));
  const tail = Math.max(4, Math.ceil(pixels.length / 16));
  const out = new Uint8Array(4 + pixels.length * 4 + tail);
  pixels.forEach(([r, g, b], i) => {
    const o = 4 + i * 4;
    out[o] = level;
    out[o + 1] = clampByte(b);
    out[o + 2] = clampByte(g);
    out[o + 3] = clampByte(r);
  });
  out.fill(0xff, 4 + pixels.length * 4);
  return out;
}

export function createStatusRing(opts: StatusRingOptions = {}): StatusRing {
  const count = opts.count ?? 12;
  const device = opts.device ?? "/dev/spidev0.1";
  const powerPin = opts.powerPin ?? 5;
  const brightness = opts.brightness ?? 10;
  const idleBrightness = opts.idleBrightness ?? 3;
  const run = opts.run ?? systemRunner();
  const write = opts.write ?? defaultWrite;
  let powered = false;

  const power = async (on: boolean): Promise<void> => {
    if (powerPin === undefined || powered === on) return;
    const res = await run("pinctrl", ["set", String(powerPin), "op", on ? "dh" : "dl"]);
    if (res.code !== 0) {
      throw new TvUnsupportedError(
        `cannot switch the LED power on GPIO${powerPin}: ${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
    powered = on;
  };

  const paint = async (pixels: readonly Rgb[], level = brightness): Promise<void> => {
    await write(device, apa102Frame(pixels, level));
  };

  return {
    show: async (state) => {
      if (state === "off") {
        await paint(Array.from({ length: count }, () => [0, 0, 0] as Rgb));
        await power(false);
        return;
      }
      // Power first. The other order writes to an unpowered strip, which
      // succeeds and shows nothing — the exact failure this comment exists for.
      await power(true);
      const colour = RING_COLOURS[state];
      await paint(Array.from({ length: count }, () => colour), state === "listening" ? idleBrightness : brightness);
    },
    off: async () => {
      await paint(Array.from({ length: count }, () => [0, 0, 0] as Rgb));
      await power(false);
    },
  };
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v))) | 0;
}

async function defaultWrite(device: string, bytes: Uint8Array): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(device, bytes);
}
