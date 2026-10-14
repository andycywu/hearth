/**
 * What the ring is showing, written where another process can read it.
 *
 * The status ring belongs to whichever Hearth process is running — the voice app, a CEC command, the lab —
 * and the avatar in the lab's window wants to look like the *real* one: hearing when the box hears, thinking
 * when it thinks. Processes do not share memory, so each state change is written to a small file on a
 * tmpfs (`$XDG_RUNTIME_DIR`, so an animation never wears the SD card), and the lab reads it.
 *
 * Only state *changes* are written, not animation frames: a handful of writes per command.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { RingState, StatusRing } from "./leds.js";

export interface RingStateRecord {
  state: RingState;
  /** Epoch ms. */
  at: number;
  /** Who is showing it, so a state left behind by a crashed process is not believed. */
  pid: number;
}

const KNOWN: ReadonlySet<string> = new Set<RingState>([
  "off", "listening", "loading", "hearing", "recognizing", "thinking", "acting", "speaking", "error",
  "verified", "unverified", "failed", "unsupported",
]);

export function ringStatePath(env: Record<string, string | undefined> = process.env): string {
  return `${env.XDG_RUNTIME_DIR || "/tmp"}/hearth-ring-state.json`;
}

/** A ring that also records what it shows. A file that cannot be written never stops the lights. */
export function withStateFile(
  ring: StatusRing,
  o: { path?: string; pid?: number; now?: () => number; write?: (path: string, text: string) => Promise<void> } = {},
): StatusRing {
  const path = o.path ?? ringStatePath();
  const pid = o.pid ?? process.pid;
  const now = o.now ?? Date.now;
  const write = o.write ?? ((p: string, t: string) => writeFile(p, t, "utf8"));
  const record = (state: RingState): void => {
    const body: RingStateRecord = { state, at: now(), pid };
    void write(path, JSON.stringify(body)).catch(() => { /* a courtesy to whoever is watching */ });
  };
  return {
    show: async (state) => { await ring.show(state); record(state); },
    off: async () => { await ring.off(); record("off"); },
  };
}

/**
 * The state recorded, or `off` if there is none worth believing: no file, a file that is not ours, a
 * process that no longer exists, or one that has not spoken for six hours.
 */
export async function readRingState(
  o: { path?: string; now?: () => number; alive?: (pid: number) => boolean; read?: (path: string) => Promise<string> } = {},
): Promise<RingStateRecord> {
  const now = o.now ?? Date.now;
  const off: RingStateRecord = { state: "off", at: now(), pid: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await (o.read ?? ((p: string) => readFile(p, "utf8")))(o.path ?? ringStatePath()));
  } catch { return off; }
  if (!parsed || typeof parsed !== "object") return off;
  const r = parsed as Record<string, unknown>;
  if (typeof r.state !== "string" || !KNOWN.has(r.state) || typeof r.at !== "number" || typeof r.pid !== "number") return off;
  if (now() - r.at > 6 * 3_600_000) return off;
  const alive = o.alive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  if (!alive(r.pid)) return off;
  return { state: r.state as RingState, at: r.at, pid: r.pid };
}
