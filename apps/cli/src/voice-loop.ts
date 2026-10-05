/**
 * The voice loop: the microphone is a second source of the same commands.
 *
 * Kept apart from `main.ts` so it can be run against a scripted microphone and
 * a recording ring, which is how "hearth, turn it down" was proved to light the
 * ring green before anyone said it to a real one.
 */
import { summarizeOutcome, type Agent } from "@hearthkit/core";
import type { PlatformProvider } from "@hearthkit/platform-api";
import type { RingState, StatusRing } from "@hearthkit/adapter-linux";
import { afterWakeWord } from "./wake.js";

export interface ListenOptions {
  ring?: StatusRing | undefined;
  wakeWord?: string | undefined;
  /** One line per thing heard, for the terminal; omitted in --quiet / --json. */
  trace?: ((line: string) => void) | undefined;
}

/**
 * Put each step's outcome on the ring, in the colour that outcome deserves.
 *
 * The television is probably showing a film. This is the one channel that can
 * answer "did that work?" without taking the picture away, so what it carries is
 * the distinction the whole runtime turns on — and `unverified` gets its own
 * colour, because amber and green mean different things to the person who asked.
 *
 * `satisfied` is green: the world was already how they wanted it, which is a
 * fine answer to "make it quieter". `denied` and `skipped` light nothing at all
 * — neither is a statement about the device, and the terminal already explains
 * them.
 */
export function showOutcomes(agent: Agent, ring: StatusRing): void {
  agent.events.on("plan:step", ({ outcome }) => {
    const state: RingState | undefined =
      outcome.status === "verified" || outcome.status === "satisfied" ? "verified"
      : outcome.status === "unverified" ? "unverified"
      : outcome.status === "unsupported" ? "unsupported"
      : outcome.status === "failed" ? "failed"
      : undefined;
    if (state) void ring.show(state);
  });
}

/**
 * One utterance, answered — planned if the agent can plan it, chatted otherwise.
 *
 * This is the routing rule the television shell applies with `?plan`, and it
 * is what makes the ring mean something: `agent.run()` alone goes through the
 * model and its tools and never emits a `plan:step`, so a spoken "turn it
 * down" would set the volume and leave the ring on white. Found by the
 * scripted-microphone test before it was found in a living room.
 */
export async function answer(agent: Agent, text: string): Promise<string> {
  const outcome = await agent.pursueIntent(text);
  if (outcome) return outcome.blocked ?? summarizeOutcome(outcome);
  return agent.run(text);
}

/**
 * Listen, hand what was heard to the same agent stdin talks to, listen again.
 *
 * `startListening` records one bounded attempt and resolves; hands-free means
 * asking again as soon as it ends. There is no wake word on this adapter — it
 * declines to implement one rather than imitate one — so this is a room
 * microphone that is always attentive, which is a thing to know before leaving
 * it switched on.
 */
export function listenForever(
  voice: NonNullable<PlatformProvider["voice"]>,
  handle: (command: string) => Promise<void>,
  opts: ListenOptions = {},
): { stop(): Promise<void> } {
  const { ring, wakeWord, trace } = opts;
  let running = true;
  // The turn in progress, if any. The loop waits for it before opening the
  // microphone again: otherwise the next window records the agent's own
  // spoken reply and sends it off to be transcribed — the box talking to
  // itself, at a per-request price — and a second "hearth" said during a
  // long step gets a "Yes?" over the top of the first answer.
  let busy: Promise<void> = Promise.resolve();

  voice.onTranscript((text, isFinal) => {
    if (!isFinal || !text.trim()) return;
    const heard = afterWakeWord(text, wakeWord);
    if (heard === undefined) {
      // Heard, transcribed, dropped: the room was talking, not to us.
      trace?.(`  🎤 (not for me) ${text}`);
      return;
    }
    trace?.(`  🎤 ${text}`);
    if (!heard) {
      // The word alone. Acknowledge, so saying it and waiting is not silence.
      busy = Promise.resolve(voice.speak("Yes?")).catch(() => {});
      return;
    }
    busy = handle(heard).catch(() => { /* handle reports its own failures */ });
  });

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        await busy;
        if (!running) break;
        await ring?.show("listening");
        await voice.startListening();
      } catch (err) {
        // One complaint, then stop: a microphone that cannot be opened will not
        // heal itself, and a tight retry loop would bury the terminal.
        trace?.(`hearth: listening stopped — ${err instanceof Error ? err.message : String(err)}`);
        running = false;
      }
    }
  };
  void loop();

  return {
    stop: async () => {
      running = false;
      await voice.stopListening();
      await busy;
    },
  };
}
