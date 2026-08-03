import { launchSearch } from "@tv-ai-agent/core";

/**
 * A self-running demo: the agent driving a TV, with nothing but a launch flag.
 *
 * Every host can show this — no keyboard, no microphone, no model, no network.
 * It exists for three jobs that turned out to be the same job: showing someone
 * what the runtime does, checking a fresh device end-to-end, and leaving
 * something on screen at a booth.
 */

/**
 * Chosen so the whole thing works against the **offline scripted brain**, and so
 * each line demonstrates something different: absolute and relative volume, a
 * read-back, an app query, then the same intents in Chinese and Japanese. Mute
 * is last-but-one and always followed by unmute, so the demo leaves the TV the
 * way it found it.
 */
export const DEFAULT_DEMO_SCRIPT = [
  "set volume to 30",
  "make it louder",
  "what's the volume?",
  "what apps are installed?",
  "現在音量多少?",
  "音量を50にして",
  "mute",
  "unmute",
];

export interface DemoOptions {
  /** Pause between commands so a viewer can read each one. Default 2500ms. */
  pauseMs?: number;
  /** Announce the command that is about to run — put it on screen. */
  onCommand?: (command: string, index: number, total: number) => void;
  /** Called when the script finishes (each time round, if looping). */
  onDone?: () => void;
  /** Keep going forever. For an unattended screen. */
  loop?: boolean;
  /** Stop looping when this returns true. */
  cancelled?: () => boolean;
  /** Injected by tests so they don't wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `commands` one at a time through `ask`, pausing between them.
 *
 * A failing command doesn't stop the demo: on a real device something *will*
 * eventually be unsupported, and a demo that dies on the first "not supported"
 * is worse than one that carries on to the next line.
 */
export async function runDemo(
  ask: (command: string) => Promise<unknown>,
  commands: readonly string[] = DEFAULT_DEMO_SCRIPT,
  opts: DemoOptions = {},
): Promise<void> {
  const pause = opts.pauseMs ?? 2500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const cancelled = opts.cancelled ?? (() => false);

  do {
    for (let i = 0; i < commands.length; i++) {
      if (cancelled()) return;
      const command = commands[i]!;
      opts.onCommand?.(command, i, commands.length);
      try {
        await ask(command);
      } catch (err) {
        console.warn("[demo] command failed:", command, err);
      }
      if (i < commands.length - 1) await sleep(pause);
    }
    opts.onDone?.();
    if (opts.loop && !cancelled()) await sleep(pause);
  } while (opts.loop && !cancelled());
}

/**
 * Is `?demo` set, and with what script? `?demo` uses the built-in script;
 * `?demo=loop` repeats it; `?ask=` entries win when present, which lets a
 * bring-up run pick its own lines.
 */
export function demoFromUrl(
  search = launchSearch(),
): { commands: readonly string[]; loop: boolean } | undefined {
  const params = new URLSearchParams(search);
  if (!params.has("demo")) return undefined;
  const asks = params.getAll("ask").map((s) => s.trim()).filter(Boolean);
  return {
    commands: asks.length ? asks : DEFAULT_DEMO_SCRIPT,
    loop: params.get("demo") === "loop",
  };
}
