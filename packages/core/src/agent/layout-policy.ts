import type { DisplayControl, ScreenLayout } from "@hearthkit/platform-api";
import type { EventBus, AgentEvents } from "../events/bus.js";

/**
 * Who decides where the picture is.
 *
 * Three layouts exist (see `ScreenLayout`): the picture alone, the picture with Hearth beside it, Hearth alone. The person's wishes come
 * first and the agent's needs second, and the rule that keeps them from fighting is one idea: there is a **resting layout**, and the agent
 * only ever *borrows* the screen from it.
 *
 *  - The resting layout starts as `fullscreen` — someone is watching, and nothing should change until Hearth has something to say.
 *  - When the agent engages (a turn or a plan starts) and the resting layout is `fullscreen`, the picture shrinks to the panel so the agent
 *    can be seen. Resting on `panel` or `hearth` needs no change: Hearth is already visible.
 *  - A moment after the agent has finished (so the reply can be read) the picture returns to the resting layout.
 *  - When the *person* asks for a layout — the model calls `set_screen_layout`, or a plan step for it runs — that choice becomes the resting
 *    layout, immediately and for good: asking for the picture to go away is not undone by the next reply.
 *
 * Best-effort by design. A display that refuses is logged and left alone; the policy never claims a layout it did not set, and it never throws
 * into the agent's turn.
 */
export interface LayoutPolicyOptions {
  events: EventBus<AgentEvents>;
  display: DisplayControl;
  /** Where the picture rests until someone says otherwise. Default `fullscreen`. */
  resting?: ScreenLayout;
  /** How long after the agent finishes before the picture returns, so a reply can be read. Default 6000 ms. */
  settleMs?: number;
  /** For tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

export interface LayoutPolicy {
  /** The layout the picture returns to. */
  readonly resting: ScreenLayout;
  /** The agent needs the screen (e.g. a confirmation is about to be asked). */
  engage(): Promise<void>;
  /** The agent is done; the picture returns after the settle time. */
  release(): void;
  dispose(): void;
}

export function createLayoutPolicy(opts: LayoutPolicyOptions): LayoutPolicy {
  const { events, display } = opts;
  const settleMs = opts.settleMs ?? 6000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = opts.log ?? ((m) => console.info(`[layout] ${m}`));

  let resting: ScreenLayout = opts.resting ?? "fullscreen";
  /** What we last asked for, set the moment we ask (two engagements in one tick must not both call) — not what the television shows. */
  let applied: ScreenLayout | undefined;
  /** True while the picture is on the panel because *we* put it there, i.e. while there is something to give back. */
  let borrowed = false;
  let timer: unknown;
  let busy = 0;
  let pendingChoice: unknown;

  const apply = async (layout: ScreenLayout): Promise<boolean> => {
    if (applied === layout) return true;
    const before = applied;
    applied = layout;
    try {
      await display.setLayout(layout);
      return true;
    } catch (e) {
      applied = before;
      log(`could not set ${layout}: ${(e as Error).message}`);
      return false;
    }
  };

  const cancelReturn = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  const engage = async (): Promise<void> => {
    busy++;
    cancelReturn();
    // Borrow the screen only from a picture that would hide us.
    if (resting === "fullscreen" && !borrowed) borrowed = await apply("panel");
  };

  const release = (): void => {
    busy = Math.max(0, busy - 1);
    if (busy > 0) return;
    cancelReturn();
    timer = setTimer(() => {
      timer = undefined;
      if (!borrowed) return;       // nothing of ours to give back
      borrowed = false;
      void apply(resting);
    }, settleMs);
  };

  /** The person chose a layout: it is where the picture rests from now on. */
  const chosen = (layout: unknown): void => {
    if (layout !== "fullscreen" && layout !== "panel" && layout !== "hearth") return;
    resting = layout;
    applied = layout;      // the tool has just set it; do not set it again
    borrowed = false;
    cancelReturn();
  };

  const offs = [
    events.on("turn:start", () => void engage()),
    events.on("turn:end", () => release()),
    events.on("plan:start", () => void engage()),
    events.on("plan:end", () => release()),
    // Chat path: the model's own call. Plan path: a step for the capability that ran. Either way it is the person's choice, relayed.
    events.on("tool:call", ({ name, args }) => {
      if (name === "set_screen_layout") pendingChoice = (args as { layout?: unknown } | undefined)?.layout;
    }),
    // Only once it has *worked*: a refused layout is not the person's resting place.
    events.on("tool:result", ({ name, result }) => {
      if (name !== "set_screen_layout") return;
      if ((result as { ok?: boolean } | undefined)?.ok === true) chosen(pendingChoice);
      pendingChoice = undefined;
    }),
    events.on("plan:step", ({ outcome }) => {
      const ran = outcome.status === "verified" || outcome.status === "unverified" || outcome.status === "satisfied";
      if (ran && outcome.step.action.capabilityId === "tv.display.set_layout") chosen(outcome.step.action.args.layout);
    }),
  ];

  return {
    get resting() { return resting; },
    engage,
    release,
    dispose: () => { cancelReturn(); offs.forEach((off) => off()); },
  };
}
