import { launchSearch, launchSearchSource, type Agent, type ConfirmRequest } from "@tv-ai-agent/core";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import { mountAgentOverlay, type OverlayController } from "./overlay.js";
import { mountAgentAvatar } from "./avatar.js";
import { mountOnScreenKeyboard } from "./keyboard.js";
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

export interface SpeakRepliesOptions {
  /**
   * Called with `true` when playback starts and `false` when it ends or fails.
   * This is how the avatar knows it is speaking — the agent has no idea TTS
   * exists, and `speak()` is fire-and-forget so nothing else could tell.
   *
   * Note that `false` means "we stopped awaiting it", which on platforms that
   * hand playback to the OS is when the call resolved rather than when the sound
   * actually stopped. Better than nothing, and honest about it.
   */
  onSpeaking?: (speaking: boolean) => void;
}

/**
 * Speak every final reply when the platform advertises a voice pipeline.
 * Returns an unsubscribe function; a no-op when the device has no voice.
 */
export function speakReplies(
  agent: Agent,
  platform: PlatformProvider,
  opts: SpeakRepliesOptions = {},
): () => void {
  if (!platform.has("voice") || !platform.voice) return () => {};
  const voice = platform.voice;
  return agent.events.on("turn:end", ({ output }) => {
    // Fire-and-forget: TTS must never delay or fail a turn. The try/catch covers
    // engines whose speak() throws synchronously instead of rejecting.
    const done = (): void => opts.onSpeaking?.(false);
    try {
      opts.onSpeaking?.(true);
      void Promise.resolve(voice.speak(output)).then(done, done);
    } catch {
      done();
    }
  });
}

/**
 * A full-screen layer for the avatar canvas, behind the shell's own text.
 *
 * Created here rather than in each host's markup and CSS: the avatar has to
 * work on four hosts whose stylesheets were written before it existed, so it
 * brings its own layer and lifts `#app` above it instead of asking them all to
 * add a z-index.
 */
function avatarMount(reserveBottom: boolean): HTMLElement {
  const existing = document.getElementById("avatar-layer");
  if (existing) return existing;
  const layer = document.createElement("div");
  layer.id = "avatar-layer";
  // Keep clear of the on-screen keyboard when there is one: the avatar draws its
  // reply as a subtitle low on its own canvas, and at full height that landed
  // underneath the keys.
  layer.style.cssText =
    `position:fixed;left:0;right:0;top:0;bottom:${reserveBottom ? "38vh" : "0"};z-index:0`;
  document.body.insertBefore(layer, document.body.firstChild);
  const app = document.getElementById("app");
  if (app) {
    app.style.position = app.style.position || "relative";
    app.style.zIndex = "1";
    // Every host centres `#app` vertically, which is exactly where the avatar's
    // face is — the status line landed on top of it. Push the shell's text to
    // the top and let the avatar own the middle and the subtitle area.
    app.style.justifyContent = "flex-start";
    app.style.paddingTop = "3vh";
  }
  // The status line is a bring-up aid, and at the hosts' own size a long flags
  // string wraps to three lines and reaches the face. Smaller here only.
  const status = document.getElementById("status");
  if (status) status.style.fontSize = "2vh";
  const hint = document.getElementById("hint");
  if (hint) hint.style.fontSize = "1.7vh";
  return layer;
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
  /**
   * Which renderer to show. `"avatar"` draws the agent's face; the default DOM
   * overlay stays the bring-up view because it puts text on screen unstyled and
   * works with no canvas at all.
   */
  render?: "overlay" | "avatar";
  /**
   * Show the remote-driven on-screen keyboard. Off by default: an automated
   * bring-up run wants the screen to itself, and `?ask=` still covers that.
   */
  keyboard?: boolean;
}

/**
 * A device shell, with the avatar's extra controls when that renderer is active.
 *
 * Optional rather than always-present so a host can wire voice once and let the
 * renderer choice decide whether anything listens — `ui.setSpeaking?.(true)` is
 * a no-op under the overlay.
 */
export interface DeviceShellController extends OverlayController {
  setListening?(listening: boolean): void;
  setSpeaking?(speaking: boolean): void;
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
): DeviceShellController {
  const ui: DeviceShellController = opts.render === "avatar"
    ? mountAgentAvatar(agent, { mount: avatarMount(opts.keyboard === true) })
    : mountAgentOverlay(agent);
  const { device } = platform;

  const status = document.getElementById(opts.statusId ?? "status");
  if (status) {
    // The launch flags are worth a few characters on screen, *and where they
    // came from*: on a TV you can't attach a debugger to, "the flag did
    // nothing" and "the flag never arrived" look identical. Telling those two
    // apart is what finally explained the Tizen build ignoring every flag.
    const search = launchSearch();
    status.textContent =
      `Ready · ${device.model} · ${device.os} ${device.osVersion} · soc=${device.soc}` +
      (opts.detail ? ` · ${opts.detail}` : "") +
      ` · flags:${launchSearchSource()}${search || "(none)"}`;
  }

  const hint = document.getElementById(opts.hintId ?? "hint");
  // A remote-driven keyboard, so a TV is no longer limited to `?ask=` at launch.
  // Opt-in per host because bring-up runs want the screen to themselves.
  const voice = platform.has("voice") ? platform.voice : undefined;
  const keyboard = opts.keyboard
    ? mountOnScreenKeyboard({
        onSubmit: (text) => ui.ask(text),
        // Speech goes through the same field, so a transcript can be corrected
        // before sending and both input methods share one place on screen.
        ...(voice ? { onMic: () => void startListening() } : {}),
      })
    : undefined;

  let listening = false;
  async function startListening(): Promise<void> {
    if (!voice || listening) return;
    listening = true;
    ui.setListening?.(true);
    try {
      await voice.startListening();
    } catch {
      listening = false;
      ui.setListening?.(false);
    }
  }

  if (voice && keyboard) {
    voice.onTranscript((text, isFinal) => {
      keyboard.setText(text);
      if (!isFinal) return;
      listening = false;
      ui.setListening?.(false);
      // Send it straight away: on a TV, making someone walk to "Send" after
      // speaking defeats the point of speaking.
      if (text.trim()) void ui.ask(text.trim());
    });
  }

  if (hint) {
    hint.textContent = opts.hint ?? (
      keyboard
        ? (platform.has("voice")
            ? "Say a command, or type one with the on-screen keyboard."
            : "Use the arrow keys and OK to type a command.")
        : platform.has("voice")
          ? "Say a command, or launch with ?ask=… to run one."
          : "No input surface on this host yet — launch with ?ask=… to run a command, " +
            "or ?diag for the capability report."
    );
  }

  if (!keyboard) return ui;
  // Tear the keyboard down with the shell, so a host that remounts doesn't
  // stack a second listener on document.
  return {
    ...ui,
    destroy: () => { keyboard.destroy(); ui.destroy(); },
  };
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
  search = launchSearch(),
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
  search = launchSearch(),
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
