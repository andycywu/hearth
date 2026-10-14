/**
 * `hearth ring` — look at the status ring without running anything else.
 *
 *   hearth ring demo        every state in turn, with what each means, ending dark
 *   hearth ring <state>     one state, held until Ctrl+C (still ones) or for a few seconds
 *   hearth ring off
 *
 * Added because "the lights don't change" could not be told apart from "the lights are broken" without
 * running the whole voice stack to find out. This runs only the lights.
 */
import {
  ANIMATED_STATES, createStatusRing, RING_COLOURS, type RingState, type StatusRing,
} from "@hearthkit/adapter-linux";

export interface RingToolIo {
  out(text: string): void;
  err(text: string): void;
}

/** Each state, in the order a command passes through them, with what it means in words. */
export const RING_STORY: ReadonlyArray<readonly [RingState, string]> = [
  ["listening", "ready — dim blue, STILL. Nothing is happening."],
  ["loading", "loading — a blue-green dot going round. The speech model is being read into memory (~20 s)."],
  ["hearing", "hearing — blue, breathing. Someone is speaking."],
  ["recognizing", "recognising — a pale tail going round. The words are being worked out."],
  ["thinking", "thinking — a white tail going round. The agent is planning."],
  ["acting", "acting — a fast cyan tail. A command is on its way (CEC, the volume)."],
  ["speaking", "speaking — magenta, breathing. The box is talking."],
  ["verified", "verified — GREEN, still. Done, and read back from the device."],
  ["unverified", "unverified — AMBER, still. Sent; nothing can confirm it."],
  ["unsupported", "unsupported — VIOLET, still. This device cannot do that."],
  ["failed", "failed — RED, still. It was tried and it did not work."],
  ["error", "error — red, blinking. It cannot carry on (the microphone went away)."],
];

const STATES = new Set<string>([...RING_STORY.map(([s]) => s), "off"]);

export interface RingToolDeps {
  ring?: StatusRing;
  sleep?: (ms: number) => Promise<void>;
  /** Resolves on Ctrl+C. */
  interrupted?: Promise<void>;
  /** How long each state is shown in `demo`. Default 4 s. */
  stepMs?: number;
}

export async function runRingTool(words: string[], io: RingToolIo, deps: RingToolDeps = {}): Promise<number> {
  const ring = deps.ring ?? createStatusRing();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const [sub] = words;

  const show = async (state: RingState): Promise<boolean> => {
    try { await ring.show(state); return true; } catch (err) {
      io.err(`hearth: cannot drive the ring: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  };

  if (sub === "demo") {
    io.out("Watch the ring. Moving means work is happening; still means nothing is.\n\n");
    for (const [state, meaning] of RING_STORY) {
      io.out(`  ${meaning}\n`);
      if (!(await show(state))) return 1;
      await sleep(deps.stepMs ?? 4_000);
    }
    await ring.off();
    io.out("\nDark again. That is every state.\n");
    return 0;
  }

  if (sub === "off") { await ring.off(); io.out("Ring off.\n"); return 0; }

  if (sub && STATES.has(sub)) {
    const state = sub as RingState;
    if (!(await show(state))) return 1;
    io.out(`${state} (${ANIMATED_STATES.has(state) ? "moving" : "still"}, colour ${RING_COLOURS[state as Exclude<RingState, "off">]?.join(",")}). Ctrl+C to stop.\n`);
    await (deps.interrupted ?? sleep(10_000));
    await ring.off();
    return 0;
  }

  io.out("hearth ring demo | off | <state>\nstates: " + RING_STORY.map(([s]) => s).join(", ") + "\n");
  return sub ? 2 : 0;
}
