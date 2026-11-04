/**
 * The judging half of `tools/voice-replay.mjs`: a recording was played into Hearth as if it were the microphone, the
 * television was read before and after, and this decides what that showed.
 *
 * Kept here, typed and tested, because the verdict is the part that must not be wrong. The other half — spawning Hearth,
 * waiting for the turn — is plumbing, and a mistake in it shows up as a timeout, not as a false "verified".
 */
import type { InputSource, ScreenLayout } from "@hearthkit/platform-api";
import type { TvModule } from "./tv-module.js";

/** What the television said about itself. A member is absent when the module cannot read it. */
export interface TvState {
  volume?: number;
  mute?: boolean;
  input?: InputSource;
  layout?: ScreenLayout;
}

/** What a spoken command should leave behind. `says` may name a before-value as `{volume}`, `{input}`, … */
export interface Expectation {
  volume?: "up" | "down" | number;
  mute?: boolean;
  input?: InputSource;
  layout?: ScreenLayout;
  says?: string;
}

export interface ReplayRun {
  /** Lines Hearth wrote to stderr: the 🎤 trace among them. */
  trace: string[];
  /** What Hearth answered, from stdout. */
  output: string;
  /** Whether the turn ended (a reply was spoken, or an error said) before the replay gave up waiting. */
  finished: boolean;
}

export type Status = "verified" | "unverified" | "failed";
export interface Check { what: string; status: Status; detail: string }
export interface Verdict { status: Status; heard: string | undefined; checks: Check[] }

/** A set-volume lands on the television's own scale and is read back through ours, so 20 can come back as 18 or 22. */
const VOLUME_SLACK = 2;

/** Read whatever the module can read; a getter that throws or is missing leaves its member out rather than guessing. */
export async function readTvState(tv: TvModule): Promise<TvState> {
  const state: TvState = {};
  const read = async <K extends keyof TvState>(key: K, get: (() => Promise<TvState[K]>) | undefined): Promise<void> => {
    if (!get) return;
    try { const v = await get(); if (v !== undefined) state[key] = v; } catch { /* unread is not a value */ }
  };
  await read("volume", tv.system?.getVolume?.bind(tv.system));
  await read("mute", tv.system?.getMute?.bind(tv.system));
  await read("input", tv.system?.getInputSource?.bind(tv.system));
  await read("layout", tv.display?.getLayout.bind(tv.display));
  return state;
}

/** The sentence that passed the wake word, from the trace — or undefined when nothing did. */
export function heardCommand(trace: readonly string[]): string | undefined {
  for (const line of trace) {
    const m = /🎤 (?!\()(.+?)(?:\s{3}\(taken as .*)?$/u.exec(line);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

export function judge(expect: Expectation, before: TvState, after: TvState, run: ReplayRun): Verdict {
  const heard = heardCommand(run.trace);
  const checks: Check[] = [];
  if (heard === undefined) {
    const missed = run.trace.filter((l) => l.includes("🎤")).map((l) => l.trim()).slice(0, 3).join(" | ");
    checks.push({ what: "heard", status: "failed", detail: missed ? `nothing passed the wake word: ${missed}` : "nothing was heard at all" });
    return { status: "failed", heard, checks };
  }
  checks.push({ what: "heard", status: "verified", detail: heard });
  if (!run.finished) checks.push({ what: "turn", status: "failed", detail: "no reply before the replay stopped waiting" });

  const compare = <K extends keyof TvState>(key: K, want: TvState[K]): void => {
    const b = before[key]; const a = after[key];
    if (a === undefined) { checks.push({ what: key, status: "unverified", detail: "the television could not be read back" }); return; }
    const ok = a === want;
    checks.push({ what: key, status: ok ? "verified" : "failed", detail: `${String(b)} → ${String(a)}${ok ? "" : ` (wanted ${String(want)})`}` });
  };

  if (expect.volume !== undefined) {
    const b = before.volume; const a = after.volume;
    if (a === undefined || b === undefined) checks.push({ what: "volume", status: "unverified", detail: "the television's volume could not be read before and after" });
    else {
      const want = expect.volume;
      const ok = want === "down" ? a < b : want === "up" ? a > b : Math.abs(a - want) <= VOLUME_SLACK;
      checks.push({ what: "volume", status: ok ? "verified" : "failed", detail: `${b} → ${a}${ok ? "" : ` (wanted ${want})`}` });
    }
  }
  if (expect.mute !== undefined) compare("mute", expect.mute);
  if (expect.input !== undefined) compare("input", expect.input);
  if (expect.layout !== undefined) compare("layout", expect.layout);
  if (expect.says !== undefined) {
    const want = expect.says.replace(/\{(\w+)\}/g, (_, k: string) => String(before[k as keyof TvState] ?? `{${k}}`));
    const ok = run.output.toLowerCase().includes(want.toLowerCase());
    checks.push({ what: "says", status: ok ? "verified" : "failed", detail: ok ? `"${want}" in the answer` : `"${want}" not in: ${run.output.trim().slice(0, 120) || "(no answer)"}` });
  }

  const status: Status = checks.some((c) => c.status === "failed") ? "failed"
    : checks.some((c) => c.status === "unverified") ? "unverified" : "verified";
  return { status, heard, checks };
}

/**
 * Put the television back the way it was before the clip, so each clip starts from the same place. Volume before mute:
 * on some sets setting the volume clears mute. Only what changed is touched, and only through what the module offers.
 */
export async function restoreTvState(tv: TvModule, before: TvState, after: TvState): Promise<string[]> {
  const done: string[] = [];
  const step = async (what: string, run: (() => Promise<void>) | undefined): Promise<void> => {
    if (!run) return;
    try { await run(); done.push(what); } catch (err) { done.push(`${what} failed: ${err instanceof Error ? err.message : String(err)}`); }
  };
  const s = tv.system; const d = tv.display;
  if (before.layout !== undefined && after.layout !== before.layout && d) await step(`layout ${before.layout}`, () => d.setLayout(before.layout!));
  if (before.input !== undefined && after.input !== before.input && s?.setInputSource) await step(`input ${before.input}`, () => s.setInputSource!(before.input!));
  if (before.volume !== undefined && after.volume !== before.volume && s?.setVolume) await step(`volume ${before.volume}`, () => s.setVolume!(before.volume!));
  if (before.mute !== undefined && (after.mute !== before.mute || after.volume !== before.volume) && s?.setMute) await step(`mute ${before.mute}`, () => s.setMute!(before.mute!));
  return done;
}
