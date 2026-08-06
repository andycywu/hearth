import { execFile } from "node:child_process";

/**
 * Running a command, behind one function.
 *
 * Every shell call in this adapter goes through here so a test can substitute a
 * recorded transcript — which is the only way the logic gets covered on a
 * machine that isn't the target. It is also the single place that decides a
 * command may not hang forever: a TV agent waiting on `pactl` is a TV agent
 * that has stopped answering.
 */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

/** Longer than any of these tools should ever take, short enough not to hang a turn. */
const TIMEOUT_MS = 5_000;

export function systemRunner(timeoutMs = TIMEOUT_MS): Runner {
  return (cmd, args) =>
    new Promise<RunResult>((resolve) => {
      // execFile, not exec: no shell, so an app name or a path with a space in
      // it can't turn into shell syntax. Arguments here come from tool calls,
      // which come from a model.
      execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
        // A non-zero exit is an ordinary answer to "is this tool here", not an
        // exception — detection asks that question repeatedly.
        const code = err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : err ? 127 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? String(err?.message ?? "") });
      });
    });
}
