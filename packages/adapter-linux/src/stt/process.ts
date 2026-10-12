/**
 * A long-lived child process, behind one function.
 *
 * `Runner` (../run.ts) runs a command to completion and hands back its output;
 * a microphone and a model server never complete. This is the streaming
 * counterpart, and it exists for the same reason: a test substitutes a scripted
 * process, so the logic around `arecord` and `sherpa-onnx` is covered on a
 * machine that has neither.
 */
import { spawn } from "node:child_process";

export interface SpawnedProcess {
  /** Raw bytes the process writes to stdout. Ends when it does. */
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly pid?: number | undefined;
  /** Everything written to stderr so far, capped, for an error message. */
  stderr(): string;
  kill(): void;
  /** Exit code, or `null` if it was killed by a signal or never started. */
  readonly exit: Promise<number | null>;
}

export interface SpawnOptions {
  /** `"ignore"` for a process whose stdout nobody reads — an unread pipe fills and blocks it. */
  stdout?: "pipe" | "ignore";
  /** Added to the parent environment. */
  env?: Record<string, string>;
}

export type Spawner = (cmd: string, args: string[], opts?: SpawnOptions) => SpawnedProcess;

const STDERR_CAP = 4_000;

export const systemSpawner: Spawner = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, {
    stdio: ["ignore", opts.stdout ?? "pipe", "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  let err = "";
  child.stderr?.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-STDERR_CAP); });
  const exit = new Promise<number | null>((resolve) => {
    // A command that is not installed is an 'error' event, not an exit code; both end the process.
    child.once("error", (e) => { err += String(e.message); resolve(null); });
    child.once("close", (code) => resolve(code));
  });
  return {
    stdout: child.stdout ?? (async function* () { /* ignored */ })(),
    pid: child.pid,
    stderr: () => err,
    kill: () => { child.kill("SIGTERM"); },
    exit,
  };
};
