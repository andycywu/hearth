import type { Agent, ConfirmRequest } from "@tv-ai-agent/core";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import { mountAgentOverlay, type OverlayController } from "./overlay.js";
import { runDemo, demoFromUrl } from "./demo.js";

/**
 * The two bits of behaviour every device host needs and the dev harness already
 * had: a confirmation gate for high-impact tools, and spoken replies where the
 * platform has a voice pipeline. Kept here so the Tizen / AOSP / webOS entries
 * stay one line each instead of three copies that drift apart.
 */

export interface ConfirmHandlerOptions {
  /**
   * Ask the user. Defaults to `window.confirm`. Swap it for a focusable 10-foot
   * dialog once each platform has one.
   */
  ask?: (question: string) => boolean | Promise<boolean>;
  /**
   * What to do when there is no way to ask (headless bundling, or an engine that
   * stubs out `window.confirm`). Default true: approve and log, so a turn never
   * stalls on a dialog nobody can see. Set false for a deny-by-default host.
   */
  fallback?: boolean;
}

/**
 * Confirmation gate for tools whose spec sets `confirm: true` (switch input,
 * launch app). Pass the result as `AgentOptions.confirm`; without it those tools
 * run unprompted.
 */
export function createConfirmHandler(
  opts: ConfirmHandlerOptions = {},
): (req: ConfirmRequest) => boolean | Promise<boolean> {
  const fallback = opts.fallback ?? true;
  const ask = opts.ask ?? defaultAsk();

  return (req: ConfirmRequest) => {
    const question = `Allow ${req.name}(${formatArgs(req.args)})?`;
    if (!ask) {
      console.info(`[confirm] no dialog available — ${fallback ? "approved" : "declined"}: ${question}`);
      return fallback;
    }
    return ask(question);
  };
}

/**
 * Speak every final reply when the platform advertises a voice pipeline.
 * Returns an unsubscribe function; a no-op when the device has no voice.
 */
export function speakReplies(agent: Agent, platform: PlatformProvider): () => void {
  if (!platform.has("voice") || !platform.voice) return () => {};
  const voice = platform.voice;
  return agent.events.on("turn:end", ({ output }) => {
    // Fire-and-forget: TTS must never delay or fail a turn. The try/catch covers
    // engines whose speak() throws synchronously instead of rejecting.
    try {
      void Promise.resolve(voice.speak(output)).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  });
}

export interface DeviceShellOptions {
  /** Element to write the status line into. Default: `#status`. */
  statusId?: string;
  /** Element to write the hint into. Default: `#hint`. */
  hintId?: string;
  /** Appended to the status line — the endpoint in use, typically. */
  detail?: string;
  /** Override the hint text (pass "" to leave the hint empty). */
  hint?: string;
}

/**
 * The standard device screen: the agent overlay, plus a status line saying what
 * the runtime decided about this device.
 *
 * Every host shipped the same shell markup (`#status`, `#hint`) and then rendered
 * nothing into it, so a freshly installed app looked broken — the agent existed
 * but no reply, tool call or error ever reached the screen. This is the one place
 * that fixes that for all of them.
 */
export function mountDeviceShell(
  agent: Agent,
  platform: PlatformProvider,
  opts: DeviceShellOptions = {},
): OverlayController {
  const ui = mountAgentOverlay(agent);
  const { device } = platform;

  const status = document.getElementById(opts.statusId ?? "status");
  if (status) {
    status.textContent =
      `Ready · ${device.model} · ${device.os} ${device.osVersion} · soc=${device.soc}` +
      (opts.detail ? ` · ${opts.detail}` : "");
  }

  const hint = document.getElementById(opts.hintId ?? "hint");
  if (hint) {
    // Say what's actually true: these hosts ship no input surface yet, so
    // whoever just installed this needs to know how to make it do something.
    hint.textContent = opts.hint ?? (
      platform.has("voice")
        ? "Say a command, or launch with ?ask=… to run one."
        : "No input surface on this host yet — launch with ?ask=… to run a command, " +
          "or ?diag for the capability report."
    );
  }

  return ui;
}

/**
 * Commands to run at startup, from `?ask=` in the page URL (repeatable):
 *
 *   index.html?ask=set%20volume%20to%2030&ask=mute
 *
 * A TV has no keyboard, so without this a freshly installed app just sits there
 * looking broken. It also gives bring-up and demos a way to drive the agent with
 * nothing but a launch command, and it is the same entry point a native "ask"
 * intent would call into later.
 */
export function commandsFromUrl(
  search = typeof location !== "undefined" ? location.search : "",
): string[] {
  return new URLSearchParams(search)
    .getAll("ask")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Whatever the launch URL asked for: `?demo` runs the built-in demo script,
 * `?ask=` runs specific commands. The command being run is echoed into the hint
 * line, because a viewer watching a TV needs to see the question, not just the
 * answer.
 *
 * Awaits `?ask=` (bring-up wants to know when it's finished) but lets `?demo`
 * run in the background, since it may loop forever.
 */
export async function runStartupCommands(
  ui: OverlayController,
  opts: { hintId?: string; search?: string } = {},
): Promise<void> {
  const hint = document.getElementById(opts.hintId ?? "hint");
  const show = (text: string): void => { if (hint) hint.textContent = text; };

  const demo = demoFromUrl(opts.search);
  if (demo) {
    void runDemo((command) => ui.ask(command), demo.commands, {
      loop: demo.loop,
      onCommand: (command, i, total) => show(`▶ ${command}   (${i + 1}/${total})`),
      onDone: () => show(demo.loop ? "" : "Demo finished — relaunch with ?demo to run it again."),
    });
    return;
  }

  for (const command of commandsFromUrl(opts.search)) {
    show(`▶ ${command}`);
    await ui.ask(command);
  }
}

/**
 * Bring-up override read from the page URL: `?confirm=auto` approves every gated
 * tool and `?confirm=deny` declines every one, both without a dialog. Returns
 * undefined when the flag is absent, so the host keeps its normal handler.
 *
 * This exists because an automated device run (`tools/device-acceptance.mjs`)
 * can't press a button on a native dialog. It is deliberately explicit and
 * logged: an auto-approving build must never be mistaken for the default.
 */
export function confirmOverrideFromUrl(
  search = typeof location !== "undefined" ? location.search : "",
): ((req: ConfirmRequest) => boolean) | undefined {
  const mode = new URLSearchParams(search).get("confirm");
  if (mode !== "auto" && mode !== "deny") return undefined;
  const approve = mode === "auto";
  console.info(`[confirm] bring-up override active: ?confirm=${mode} — every gated tool is auto-${approve ? "approved" : "declined"}`);
  return (req: ConfirmRequest) => {
    console.info(`[confirm] ${approve ? "approved" : "declined"} ${req.name}`);
    return approve;
  };
}

function defaultAsk(): ((question: string) => boolean) | undefined {
  const w = typeof window !== "undefined" ? (window as Window & { confirm?: unknown }) : undefined;
  return typeof w?.confirm === "function" ? (q: string) => window.confirm(q) : undefined;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args).map(([k, v]) => `${k}=${String(v)}`).join(", ");
}
