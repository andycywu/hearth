#!/usr/bin/env node
/**
 * The TV agent, in a terminal.
 *
 * Same agent loop, same tools, same adapters as the television builds — this is
 * a different *front end*, not a different agent, and that is only possible
 * because `core` never touches a DOM. The browser hosts mount a UI; this one
 * reads lines and writes lines.
 *
 * Intended for a Linux device that is itself the TV — a set-top box, a Pi —
 * where there is a shell but no browser worth using.
 */
import { createInterface } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin, stdout, stderr, argv, env, exit } from "node:process";
import { Agent } from "@tv-ai-agent/core";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import {
  createOpenAiCompatibleClient, createScriptedClient,
} from "@tv-ai-agent/llm-connectors";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import { parseArgs, HELP, type CliOptions } from "./args.js";

const VERSION = "0.1.0";

async function main(): Promise<number> {
  const opts = parseArgs(argv.slice(2), env);

  if (opts.help) { stdout.write(HELP); return 0; }
  if (opts.version) { stdout.write(`${VERSION}\n`); return 0; }
  for (const problem of opts.errors) stderr.write(`tv-agent: ${problem}\n`);
  if (opts.errors.length) { stderr.write("try --help\n"); return 2; }
  for (const warning of opts.warnings) stderr.write(`tv-agent: ${warning}\n`);

  const platform = await openPlatform(opts.platform);
  const agent = new Agent({
    platform,
    llm: opts.baseUrl
      ? createOpenAiCompatibleClient({
          baseUrl: opts.baseUrl,
          model: opts.model,
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        })
      : createScriptedClient(),
    confirm: confirmer(opts),
  });

  if (!opts.quiet && !opts.json) {
    agent.events.on("tool:call", ({ name, args }) => {
      stderr.write(`  · ${name}(${compactArgs(args)})\n`);
    });
  }

  // One agent for the whole session, so "make it louder" after "set volume to
  // 30" means what it should. That is `ConversationContext` doing its job; a
  // fresh Agent per line would throw the conversation away.
  const commands = opts.commands.length ? opts.commands : await readLines();
  let failures = 0;
  for await (const command of commands) {
    if (!command.trim()) continue;
    try {
      const output = await agent.run(command);
      stdout.write(opts.json
        ? JSON.stringify({ ok: true, input: command, output }) + "\n"
        : output + "\n");
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      if (opts.json) stdout.write(JSON.stringify({ ok: false, input: command, error: message }) + "\n");
      else stderr.write(`tv-agent: ${message}\n`);
    }
  }
  // A non-zero exit for a failed turn, so this composes in a shell script.
  return failures ? 1 : 0;
}

/**
 * Lines from stdin, one command each.
 *
 * A prompt is written only when stdin is a terminal: `echo … | tv-agent` should
 * emit the answer and nothing else, and a prompt would land in the pipe.
 */
async function* readLines(): AsyncGenerator<string> {
  const interactive = stdin.isTTY === true;
  if (interactive) stderr.write("tv-agent — type a command, or Ctrl-D to leave\n");
  const rl = createInterface({ input: stdin, terminal: interactive });
  if (interactive) stderr.write("> ");
  let first = true;
  for await (const line of rl) {
    // A byte-order mark on the first line, which anything piped from a Windows
    // tool or a UTF-8-with-BOM file carries. Invisible, and it becomes part of
    // the command: it survived here only because the offline brain matches
    // loosely, and a stricter model would have been handed "﻿mute".
    yield first ? line.replace(/^﻿/, "") : line;
    first = false;
    if (interactive) stderr.write("> ");
  }
  if (interactive) stderr.write("\n");
}

/**
 * Ask before a tool with side effects runs.
 *
 * Without a terminal there is nobody to ask, and blocking forever is the worst
 * of the options: `--yes` says approve, and its absence means decline with an
 * explanation rather than hang a pipeline.
 */
function confirmer(opts: CliOptions): (req: { name: string; args: Record<string, unknown> }) => Promise<boolean> {
  return async (req) => {
    if (opts.yes) return true;
    if (stdin.isTTY !== true) {
      stderr.write(`tv-agent: ${req.name} needs confirmation; re-run with --yes\n`);
      return false;
    }
    // The promise flavour: the callback `readline` has no awaitable question().
    const rl = createPromptInterface({ input: stdin, output: stderr, terminal: true });
    try {
      const answer = await rl.question(`Allow ${req.name}(${compactArgs(req.args)})? [y/N] `);
      // Default No, matching the on-screen dialog: the gate exists to stop side
      // effects nobody asked for, so a bare Enter must not approve one.
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

async function openPlatform(name: CliOptions["platform"]): Promise<PlatformProvider> {
  if (name === "linux") {
    // Deliberately a clear error rather than a silent fall back to the mock:
    // "it ran and did nothing to my TV" is a much worse afternoon than "that
    // adapter isn't here yet".
    const { createLinuxAdapter } = await import("@tv-ai-agent/adapter-linux");
    const platform = createLinuxAdapter();
    await platform.init();
    return platform;
  }
  const platform = createWebAdapter();
  await platform.init();
  return platform;
}

/** Tool arguments on one line, short enough to scan in a trace. */
function compactArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

main().then(exit, (err: unknown) => {
  stderr.write(`tv-agent: ${err instanceof Error ? err.message : String(err)}\n`);
  exit(1);
});
