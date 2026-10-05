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
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin, stdout, stderr, argv, env, exit } from "node:process";
import { Agent } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import {
  createOpenAiCompatibleClient, createScriptedClient,
} from "@hearthkit/llm-connectors";
import type { PlatformProvider } from "@hearthkit/platform-api";
import type { RingState, StatusRing } from "@hearthkit/adapter-linux";
import { parseArgs, HELP, type CliOptions } from "./args.js";
import { readLines } from "./terminal.js";
import { assembleRoom } from "./room.js";
import { runReport } from "./report.js";
import { runSetup } from "./setup.js";
import { afterWakeWord } from "./wake.js";
import { configAsEnv, loadConfig } from "./config.js";

const VERSION = "0.3.0";

async function main(): Promise<number> {
  // What `hearth setup` wrote sits underneath the real environment, so the
  // parser keeps its one rule — flag > env > default — and the file is the
  // quietest voice of the three.
  const opts = parseArgs(argv.slice(2), { ...configAsEnv(await loadConfig()), ...env });

  if (opts.help) { stdout.write(HELP); return 0; }
  if (opts.version) { stdout.write(`${VERSION}\n`); return 0; }
  for (const problem of opts.errors) stderr.write(`hearth: ${problem}\n`);
  if (opts.errors.length) { stderr.write("try --help\n"); return 2; }
  for (const warning of opts.warnings) stderr.write(`hearth: ${warning}\n`);

  // `hearth setup` looks at the box directly; it does not need the agent.
  if (opts.setup) {
    return runSetup(opts, {
      out: (text) => { stdout.write(text); },
      err: (text) => { stderr.write(text); },
    });
  }

  const platform = await openPlatform(opts);

  // `hearth report`: the same platform and the same room, a different question.
  if (opts.report) {
    // stdout is the report and nothing else, so it can be redirected into a
    // file or an issue body. Anything an adapter logs goes to stderr.
    for (const level of ["log", "info", "warn", "debug"] as const) {
      console[level] = (...a: unknown[]) => { stderr.write(a.map(String).join(" ") + "\n"); };
    }
    return runReport(opts, platform, {
      out: (text) => { stdout.write(text); },
      err: (text) => { stderr.write(text); },
    });
  }

  // What is in the room, and what this box can reach past the television —
  // HDMI-CEC on a Pi. A box with no bus gets an empty list and one note.
  const room = await assembleRoom(opts, platform);
  if (!opts.quiet && !opts.json) {
    for (const note of [...room.notes, ...room.tree]) stderr.write(`hearth: ${note}\n`);
  }

  const agent = new Agent({
    platform,
    devices: room.devices,
    ...(room.capabilities.length ? { capabilities: room.capabilities } : {}),
    ...(room.tools.length ? { tools: room.tools } : {}),
    llm: opts.baseUrl
      ? createOpenAiCompatibleClient({
          baseUrl: opts.baseUrl,
          model: opts.model,
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        })
      : createScriptedClient(),
    confirm: confirmer(opts),
  });

  // Same as the TV hosts: find out what this machine can actually do before
  // offering it. On Linux with no audio backend that is the difference between
  // "I can set volume" and being able to.
  const capabilities = await agent.probeCapabilities();
  if (!opts.quiet && !opts.json) {
    for (const note of capabilities.notes) stderr.write(`hearth: ${note}
`);
  }

  if (!opts.quiet && !opts.json) {
    agent.events.on("tool:call", ({ name, args }) => {
      stderr.write(`  · ${name}(${compactArgs(args)})\n`);
    });
  }

  const ring = opts.leds && opts.platform === "linux" ? await openRing() : undefined;
  if (ring) showOutcomes(agent, ring);

  let failures = 0;
  const handle = async (command: string): Promise<void> => {
    try {
      await ring?.show("thinking");
      const output = await agent.run(command);
      stdout.write(opts.json
        ? JSON.stringify({ ok: true, input: command, output }) + "\n"
        : output + "\n");
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      if (opts.json) stdout.write(JSON.stringify({ ok: false, input: command, error: message }) + "\n");
      else stderr.write(`hearth: ${message}\n`);
      await ring?.show("failed");
    }
  };

  // The microphone is a second source of the same commands, not a second agent:
  // a spoken "make it louder" continues the conversation a typed one started,
  // because both go through the one `agent` above.
  const voice = platform.has("voice") ? platform.voice : undefined;
  const spoken = opts.voice && voice ? listenForever(voice, ring, handle, opts) : undefined;
  if (opts.voice && !spoken) {
    stderr.write("hearth: this platform reports no voice; carrying on with stdin only\n");
  }
  if (voice) speakReplies(agent, voice);


  // One agent for the whole session, so "make it louder" after "set volume to
  // 30" means what it should. That is `ConversationContext` doing its job; a
  // fresh Agent per line would throw the conversation away.
  const commands = opts.commands.length ? opts.commands : await readLines();
  for await (const command of commands) {
    if (!command.trim()) continue;
    await handle(command);
  }
  await spoken?.stop();
  await ring?.off();
  // A non-zero exit for a failed turn, so this composes in a shell script.
  return failures ? 1 : 0;
}

/**
 * The status ring, if this box has one.
 *
 * Optional in every sense: a Pi without a ReSpeaker array has no `/dev/spidev0.1`
 * and no GPIO5 to switch, and none of that should stop the agent running. A ring
 * that cannot be opened is reported once and then forgotten about.
 */
async function openRing(): Promise<StatusRing | undefined> {
  try {
    const { createStatusRing } = await import("@hearthkit/adapter-linux");
    const ring = createStatusRing();
    await ring.off();          // proves the power gate and the bus before relying on them
    return ring;
  } catch (err) {
    stderr.write(`hearth: no status ring (${err instanceof Error ? err.message : String(err)})\n`);
    return undefined;
  }
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
function showOutcomes(agent: Agent, ring: StatusRing): void {
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
 * Say each reply out loud.
 *
 * `packages/ui` has a `speakReplies` already, and this is deliberately not it:
 * that module reaches for an overlay, an avatar and an on-screen keyboard, none
 * of which exist in a terminal. Ten lines here is a better trade than dragging
 * a DOM into a Node process — and it is the same ten lines, including the part
 * that matters: **speaking must never delay or fail a turn**, so this is
 * fire-and-forget and swallows its own errors.
 */
function speakReplies(agent: Agent, voice: NonNullable<PlatformProvider["voice"]>): void {
  agent.events.on("turn:end", ({ output }) => {
    if (!output.trim()) return;
    try {
      void Promise.resolve(voice.speak(output)).catch(() => {});
    } catch { /* an engine that throws synchronously is still not a failed turn */ }
  });
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
function listenForever(
  voice: NonNullable<PlatformProvider["voice"]>,
  ring: StatusRing | undefined,
  handle: (command: string) => Promise<void>,
  opts: CliOptions,
): { stop(): Promise<void> } {
  let running = true;

  voice.onTranscript((text, isFinal) => {
    if (!isFinal || !text.trim()) return;
    const heard = afterWakeWord(text, opts.wakeWord);
    if (heard === undefined) {
      // Heard, transcribed, dropped: the room was talking, not to us.
      if (!opts.quiet && !opts.json) stderr.write(`  🎤 (not for me) ${text}\n`);
      return;
    }
    if (!opts.quiet && !opts.json) stderr.write(`  🎤 ${text}\n`);
    if (!heard) {
      // The word alone. Acknowledge, so saying it and waiting is not silence.
      void Promise.resolve(voice.speak("Yes?")).catch(() => {});
      return;
    }
    void handle(heard);
  });

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        await ring?.show("listening");
        await voice.startListening();
      } catch (err) {
        // One complaint, then stop: a microphone that cannot be opened will not
        // heal itself, and a tight retry loop would bury the terminal.
        stderr.write(`hearth: listening stopped — ${err instanceof Error ? err.message : String(err)}\n`);
        running = false;
      }
    }
  };
  void loop();

  return {
    stop: async () => {
      running = false;
      await voice.stopListening();
    },
  };
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
      stderr.write(`hearth: ${req.name} needs confirmation; re-run with --yes\n`);
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

async function openPlatform(opts: CliOptions): Promise<PlatformProvider> {
  if (opts.platform === "linux") {
    // Deliberately a clear error rather than a silent fall back to the mock:
    // "it ran and did nothing to my TV" is a much worse afternoon than "that
    // adapter isn't here yet".
    const linux = await import("@hearthkit/adapter-linux");
    // A report asks what the box *has*, not what this run was started with. So
    // the voice pipeline is wired for `hearth report` even without --voice: it
    // is the only way `init()` goes looking for arecord and espeak-ng, and the
    // first Pi report said "voice unsupported" about a box with both.
    const wantVoice = opts.voice || opts.report;
    const platform = linux.createLinuxAdapter({
      ...(wantVoice
        ? {
            voice: {
              // Dropped windows are worth one line in the trace: a microphone
              // that seems deaf and a room that is quiet look the same otherwise.
              ...(!opts.quiet && !opts.json
                ? { onDropped: (reason: string) => { stderr.write(`  🎤 (${reason})\n`); } }
                : {}),
              // No endpoint means no transcriber, and the adapter then answers
              // `unsupported` for listening rather than recording audio it has
              // no way to read. `parseArgs` has already said so out loud.
              ...(opts.asrBaseUrl
                ? {
                    transcribe: linux.createOpenAiTranscriber({
                      baseUrl: opts.asrBaseUrl,
                      ...(opts.asrModel ? { model: opts.asrModel } : {}),
                      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
                    }),
                  }
                : {}),
            },
          }
        : {}),
    });
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
  stderr.write(`hearth: ${err instanceof Error ? err.message : String(err)}\n`);
  exit(1);
});
