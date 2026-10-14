/**
 * The status ring — four honest answers, in a colour each, and a still-or-moving
 * signal for everything before them.
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
 * ## What the ring says while the box is working
 *
 * Those four are *answers*. Before an answer there is a stretch of work nobody
 * can see — the model loading, a voice heard, words being worked out, a plan, a
 * command on the HDMI bus, the box talking — and a ring that is dark through all
 * of it looks identical to a ring that is broken (2026-10-14: "the lights don't
 * change"). So the working states move, and the resting state does not:
 * **anything moving means work is happening, and a still ring means nothing is.**
 * A still ring is the dim blue "ready", or an answer held for a couple of
 * seconds so it can be read; it never moves.
 *
 *   loading       a blue-green dot going round   the model is being read into memory (~20 s on a Pi 3B)
 *   hearing       blue, breathing                speech is being heard right now
 *   recognizing   a pale tail going round        the words are being worked out
 *   thinking      a white tail going round       the agent is planning
 *   acting        a cyan tail, faster            a command is on its way (a CEC message, the volume)
 *   speaking      magenta, breathing             the box is talking
 *   error         red, blinking                  it cannot carry on (the microphone went away)
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
 * What the ring can say: the resting state, the work around an answer, and the
 * four answers themselves.
 */
export type RingState =
  | "off" | "listening"
  | "loading" | "hearing" | "recognizing" | "thinking" | "acting" | "speaking" | "error"
  | "verified" | "unverified" | "failed" | "unsupported";

/** The states that move. Everything else is painted once and stays. */
export const ANIMATED_STATES: ReadonlySet<RingState> = new Set<RingState>([
  "loading", "hearing", "recognizing", "thinking", "acting", "speaking", "error",
]);

/** The four answers: held still for a moment so they can be read, then the ring settles. */
export const OUTCOME_STATES: ReadonlySet<RingState> = new Set<RingState>([
  "verified", "unverified", "failed", "unsupported",
]);

/**
 * Deliberately not a gradient. Someone across a room is reading hue, not
 * brightness, and the four outcomes have to be told apart at a glance by a
 * person who is not looking for them. Every state has a colour of its own — the
 * moving ones as well — so a still frame from any of them is not mistaken for
 * another.
 */
export const RING_COLOURS: Record<Exclude<RingState, "off">, Rgb> = {
  listening: [0, 90, 255],
  loading: [0, 170, 170],
  hearing: [60, 160, 255],
  recognizing: [180, 210, 255],
  thinking: [255, 255, 255],
  acting: [0, 220, 255],
  speaking: [255, 0, 160],
  error: [255, 0, 40],
  verified: [0, 255, 60],
  unverified: [255, 140, 0],
  failed: [255, 0, 0],
  unsupported: [150, 0, 255],
};

export interface RingScheduler {
  now(): number;
  /** Call `fn` every `ms`; returns a function that stops it. */
  every(ms: number, fn: () => void): () => void;
  /** Call `fn` once after `ms`; returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
}

/** Timers that do not keep the process alive: a ring animation is never a reason not to exit. */
export const realScheduler: RingScheduler = {
  now: () => Date.now(),
  every: (ms, fn) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); },
  after: (ms, fn) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); },
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
  /**
   * 0-31, for the moving states. Above idle so work is visible, below an answer, because twelve LEDs at
   * full white are a real load on a Pi 3B's supply: the first time this ring ran while the model loaded
   * was the moment the board reported under-voltage.
   */
  animBrightness?: number;
  /** Milliseconds per animation frame. Default 90. */
  frameMs?: number;
  /** How long an answer stays on the ring before it settles. Default 2500. */
  holdMs?: number;
  run?: Runner;
  /** Injected in tests; defaults to writing the bytes to the spidev device. */
  write?: (device: string, bytes: Uint8Array) => Promise<void>;
  scheduler?: RingScheduler;
  /** Told if a frame painted from a timer cannot be written; that animation then stops. */
  onError?: (err: unknown) => void;
}

export interface StatusRing {
  show(state: RingState): Promise<void>;
  /** Powers the ring down as well, so an idle device is dark rather than black. */
  off(): Promise<void>;
}

const BLACK: Rgb = [0, 0, 0];
const scale = (c: Rgb, f: number): Rgb => [c[0] * f, c[1] * f, c[2] * f];

/**
 * One frame of a moving state, as a pure function of the tick — `undefined` for a state that does not move.
 *
 * Chases go round one LED per tick (`acting` two, because a command on the bus is quick) with a fading tail so
 * the direction can be read; breathing is one slow cosine so it never reads as a flash.
 */
export function ringFrame(state: RingState, tick: number, count: number): readonly Rgb[] | undefined {
  if (!ANIMATED_STATES.has(state)) return undefined;
  const colour = RING_COLOURS[state as Exclude<RingState, "off">];
  const chase = (tail: number, step: number): Rgb[] => {
    const head = (tick * step) % count;
    return Array.from({ length: count }, (_, i) => {
      const behind = (head - i + count) % count;
      return behind < tail ? scale(colour, 1 - behind / tail) : BLACK;
    });
  };
  const breathe = (): Rgb[] => {
    const f = 0.2 + 0.8 * (0.5 - 0.5 * Math.cos((2 * Math.PI * tick) / 24));
    return Array.from({ length: count }, () => scale(colour, f));
  };
  switch (state) {
    case "loading": return Array.from({ length: count }, (_, i) => (i === tick % count ? colour : BLACK));
    case "recognizing": return chase(4, 1);
    case "thinking": return chase(5, 1);
    case "acting": return chase(3, 2);
    case "hearing":
    case "speaking": return breathe();
    case "error": return Array.from({ length: count }, () => (tick % 10 < 5 ? colour : BLACK));
    default: return undefined;
  }
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
  const animBrightness = opts.animBrightness ?? 8;
  const frameMs = opts.frameMs ?? 90;
  const holdMs = opts.holdMs ?? 2_500;
  const run = opts.run ?? systemRunner();
  const write = opts.write ?? defaultWrite;
  const sched = opts.scheduler ?? realScheduler;
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
  const dark = Array.from({ length: count }, () => BLACK);

  let current: RingState = "off";
  let tick = 0;
  let stopAnimation: (() => void) | undefined;
  let cancelSettle: (() => void) | undefined;
  let holdUntil = 0;
  let deferred: RingState | undefined;

  const halt = (): void => {
    stopAnimation?.(); stopAnimation = undefined;
    cancelSettle?.(); cancelSettle = undefined;
  };

  const apply = async (state: RingState): Promise<void> => {
    halt();
    current = state;
    if (state === "off") {
      await paint(dark);
      await power(false);
      return;
    }
    // Power first. The other order writes to an unpowered strip, which
    // succeeds and shows nothing — the exact failure this comment exists for.
    await power(true);

    const first = ringFrame(state, 0, count);
    if (first) {
      tick = 0;
      await paint(first, animBrightness);
      let failed = false;
      stopAnimation = sched.every(frameMs, () => {
        if (failed) return;
        tick++;
        // A frame that cannot be written must not become an unhandled rejection in a timer: stop moving, say so once.
        paint(ringFrame(state, tick, count) ?? dark, animBrightness).catch((err: unknown) => {
          // Several frames can be in flight when the first failure lands; only the first is news.
          if (failed) return;
          failed = true;
          opts.onError?.(err);
        });
      });
      return;
    }

    const colour = RING_COLOURS[state];
    await paint(Array.from({ length: count }, () => colour), state === "listening" ? idleBrightness : brightness);
    if (OUTCOME_STATES.has(state)) {
      holdUntil = sched.now() + holdMs;
      // An answer is held still so it can be read, then the ring settles to ready — unless something is already waiting.
      cancelSettle = sched.after(holdMs, () => {
        const next = deferred ?? "listening";
        deferred = undefined;
        apply(next).catch((err: unknown) => opts.onError?.(err));
      });
    }
  };

  return {
    show: async (state) => {
      // An answer keeps the ring for its hold: the next thing the voice loop does is show "listening", and without
      // this a green flash would last as long as it takes to write the next frame.
      if (state !== "off" && !OUTCOME_STATES.has(state) && OUTCOME_STATES.has(current) && sched.now() < holdUntil) {
        deferred = state;
        return;
      }
      deferred = undefined;
      await apply(state);
    },
    off: async () => {
      deferred = undefined;
      await apply("off");
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
