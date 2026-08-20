import { createInterface, type ReadLineOptions } from "node:readline";
import { stdin, stderr } from "node:process";

/**
 * Reading commands from a terminal, separated from `main.ts` so the rules can be
 * tested — importing `main.ts` would run the CLI.
 */

/**
 * How to configure readline for a terminal, or for a pipe.
 *
 * **`output` is what echoes your typing.** In terminal mode readline draws the
 * input line itself; with no output stream it reads the keys and shows nothing,
 * so you type blind. It costs you backspace, arrow keys and history too, since
 * readline can only offer those when it can draw. This shipped broken, and it is
 * the kind of thing that looks fine in every non-interactive test.
 *
 * stderr rather than stdout: the reply goes to stdout so `hearth … | …` pipes
 * the answer alone, and neither the prompt nor the user's own keystrokes belong
 * in that. Omitted entirely for a pipe, so nothing extra is written at all.
 */
export function readlineOptions(interactive: boolean): ReadLineOptions {
  return {
    input: stdin,
    ...(interactive ? { output: stderr } : {}),
    terminal: interactive,
    prompt: "> ",
  };
}

/** A leading byte-order mark, which anything piped from a Windows tool carries. */
export function stripBom(line: string): string {
  return line.replace(/^﻿/, "");
}

/**
 * Lines from stdin, one command each.
 *
 * The banner and prompt go to stderr only when stdin is a terminal: `echo … |
 * hearth` should emit the answer and nothing else.
 */
export async function* readLines(): AsyncGenerator<string> {
  const interactive = stdin.isTTY === true;
  if (interactive) stderr.write("hearth — type a command, or Ctrl-D to leave\n");

  const rl = createInterface(readlineOptions(interactive));
  if (interactive) rl.prompt();

  let first = true;
  for await (const line of rl) {
    // Invisible, and it becomes part of the command: a BOM survived here only
    // because the offline brain matches loosely, and a stricter model would
    // have been handed "﻿mute".
    yield first ? stripBom(line) : line;
    first = false;
    // After the turn's output, not before it: the generator only resumes once
    // the caller has finished printing, so the prompt lands under the reply.
    if (interactive) rl.prompt();
  }
  if (interactive) stderr.write("\n");
}
