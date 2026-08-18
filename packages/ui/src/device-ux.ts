import { launchSearch, launchSearchSource, redactSecrets, type Agent, type ConfirmRequest } from "@tv-ai-agent/core";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import { mountAgentOverlay, type OverlayController } from "./overlay.js";
import { mountAgentAvatar } from "./avatar.js";
import { mountOnScreenKeyboard, remoteIntent } from "./keyboard.js";
import { mountMicButton } from "./mic-button.js";
import { createListeningState } from "./listening.js";
import { createTvConfirmDialog, type TvConfirmDialog } from "./confirm-dialog.js";
import { runDemo, demoFromUrl } from "./demo.js";

/**
 * The two bits of behaviour every device host needs and the dev harness already
 * had: a confirmation gate for high-impact tools, and spoken replies where the
 * platform has a voice pipeline. Kept here so the Tizen / AOSP / webOS entries
 * stay one line each instead of three copies that drift apart.
 */

export interface ConfirmHandlerOptions {
  /**
   * Ask the user. Defaults to the remote-driven dialog in `confirm-dialog.ts`
   * wherever there's a DOM, falling back to `window.confirm` on engines that
   * have one but no document.
   */
  ask?: (question: string) => boolean | Promise<boolean>;
  /**
   * What to do when there is no way to ask (headless bundling, or an engine that
   * stubs out `window.confirm`). Default true: approve and log, so a turn never
   * stalls on a dialog nobody can see. Set false for a deny-by-default host.
   */
  fallback?: boolean;
  /**
   * Ask in terms of the tool call rather than in plain words. Defaults to
   * `?debug`, which is where the raw form belongs: it is what you want when you
   * are checking that the right arguments reached the gate, and the last thing a
   * viewer should be shown.
   */
  technical?: boolean;
}

/**
 * The confirmation question, in words someone holding a remote can answer.
 *
 * It used to read `Allow set_input_source(source=hdmi1)?`, which asks a viewer
 * to approve a function signature — the one place in the app where the
 * engineering face had real consequences, because the safe answer to a question
 * you don't understand is always No.
 *
 * Only the two gated tools get a sentence. Everything else — a skill manifest's
 * own tool, anything added later — falls back to the tool's `description`, which
 * a manifest author writes in prose anyway, and to the raw form after that. That
 * way an unknown tool degrades to something readable instead of needing an entry
 * here to be presentable.
 */
export function confirmQuestion(req: ConfirmRequest, technical = false): string {
  if (technical) return `Allow ${req.name}(${formatArgs(req.args)})?`;

  /**
   * A sentence, plus any argument the sentence didn't already account for.
   *
   * The rewrite must not quietly narrow what is being approved: this is the one
   * dialog in the app with side effects behind it, so an argument the viewer
   * can't see is an argument they didn't agree to. `spoken` names the keys the
   * sentence covers; anything else is appended rather than dropped.
   */
  const ask = (sentence: string, ...spoken: string[]): string => {
    const rest = Object.entries(req.args).filter(([k]) => !spoken.includes(k));
    if (!rest.length) return `${sentence}?`;
    return `${sentence}? (${rest.map(([k, v]) => `${k}: ${String(v)}`).join(", ")})`;
  };

  switch (req.name) {
    case "set_input_source":
      return ask(`Switch the TV input to ${labelValue(req.args.source)}`, "source");
    case "launch_app":
      return ask(`Open ${labelValue(req.args.appId)}`, "appId");
    default: {
      // A description is a statement ("Switch the active input source."); turn it
      // into the question being asked without gluing a "?" onto a full stop.
      const sentence = req.description?.trim().replace(/\.$/, "");
      if (sentence) return ask(sentence);
      return `Allow ${req.name}(${formatArgs(req.args)})?`;
    }
  }
}

/**
 * An argument as a viewer would say it: `hdmi1` → `HDMI 1`, an app id's last
 * segment → `Netflix`. Best-effort on purpose — it is a label, not an
 * identifier, and the id is still in the log and under `?debug`.
 */
function labelValue(value: unknown): string {
  const raw = String(value ?? "");
  const hdmi = /^hdmi(\d+)$/i.exec(raw);
  if (hdmi) return `HDMI ${hdmi[1]}`;
  // App ids are reverse-DNS (`com.netflix.ninja`); the last segment is the only
  // part anyone recognises, and even that only sometimes.
  const segment = raw.includes(".") ? raw.split(".").pop()! : raw;
  return segment.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
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
    const question = confirmQuestion(req, opts.technical ?? debugRequested());
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
  // The hosts' own `#app` block was the screen: a status line and a hint, both
  // written for bring-up. Under the avatar it has nothing left to show — the
  // greeting and the reply are drawn on the canvas, where they can respond to
  // what the agent is doing — so it gets out of the way entirely and the debug
  // line (if any) positions itself from the theme.
  const app = document.getElementById("app");
  if (app) app.style.display = "contents";
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
   * Override the idle greeting the avatar shows before anything has been said.
   * Pass "" for a screen with nothing but the form on it.
   */
  greeting?: string;
  /**
   * Which renderer to show. `"avatar"` draws the agent's face; the default DOM
   * overlay stays the bring-up view because it puts text on screen unstyled and
   * works with no canvas at all.
   */
  render?: "overlay" | "avatar";
  /**
   * Show the remote-driven on-screen keyboard. Off by default: an automated
   * bring-up run wants the screen to itself, and `?ask=` still covers that.
   * A layout name opens on that layout — `"phrases"` for a build whose viewers
   * mostly speak Chinese, where typing characters isn't an option.
   */
  keyboard?: boolean | string;
  /**
   * Let the agent plan, not just chat. Defaults to whether `?plan` was passed.
   * See `planRequested`.
   */
  plan?: boolean;
}

/**
 * A device shell, with the avatar's extra controls when that renderer is active.
 *
 * Optional rather than always-present so a host can wire voice once and let the
 * renderer choice decide whether anything listens — `ui.setSpeaking?.(true)` is
 * a no-op under the overlay.
 */
/**
 * Start a turn from a UI gesture and stop caring about the promise.
 *
 * A turn that fails has already reached the screen — the agent emits `error`
 * and the view model paints it — so there is nothing left to handle here. What
 * is left is the rejection itself: discarded with a bare `void`, it surfaces as
 * an unhandled promise rejection, which on some TV runtimes is a crash rather
 * than a console line.
 *
 * Not hypothetical: on the Tizen emulator `tizen.application.launch` accepts an
 * app id and then never calls back, so "open Gallery" runs out its 30-second
 * budget and the turn rejects. The screen showed the warning correctly and the
 * rejection went nowhere.
 */
function askAndForget(ui: Pick<OverlayController, "ask">, text: string): void {
  void ui.ask(text).catch(() => {
    /* already rendered via the agent's `error` event */
  });
}

/**
 * Should this build let the agent *plan* what it is asked, rather than only chat?
 *
 * Opt-in per launch, and off by default on a device, for one specific reason: the
 * automated bring-up run (`tools/device-acceptance.mjs`) asserts a tool sequence
 * read out of logcat, and plan mode legitimately produces a different one — it
 * resolves "make it louder" from world state instead of re-reading the TV. Turning
 * it on silently would have broken the one check that proves the device still
 * works. `?plan` turns it on; `?plan=off` is also accepted, so the flag reads the
 * same way it does in the dev harness.
 */
export function planRequested(search = launchSearch()): boolean {
  const value = new URLSearchParams(search).get("plan");
  return value !== null && value !== "off" && value !== "0" && value !== "false";
}

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
  const { device } = platform;
  const voice = platform.has("voice") ? platform.voice : undefined;

  // What to tell someone who has just turned the TV on. Computed before the
  // renderer is mounted because the avatar draws it itself — it has to vanish
  // the moment there is a real reply, and only the renderer knows when that is.
  const hintText = opts.hint ?? inviteText(Boolean(opts.keyboard), Boolean(voice));

  const ui: DeviceShellController = opts.render === "avatar"
    // Boolean(), not `=== true`: `keyboard` also takes a layout name, and
    // `?keyboard=phrases` was leaving the avatar at full height with its
    // subtitle behind the keys.
    ? mountAgentAvatar(agent, {
        mount: avatarMount(Boolean(opts.keyboard)),
        ...(opts.greeting !== undefined ? { greeting: opts.greeting } : {}),
        hint: hintText,
        showActivity: debugRequested(),
      })
    : mountAgentOverlay(agent);

  // With plan mode on, every way in — the keyboard, the microphone, `?ask=`, the
  // demo script — goes through the agent's own routing: a goal it can plan is
  // planned and verified, and anything else is a conversation exactly as before.
  // Wrapping the controller rather than each call site is what makes that true of
  // the ways in that this file does not own.
  const plan = opts.plan ?? planRequested();
  if (plan) {
    const chat = ui.ask.bind(ui);
    ui.ask = async (text: string) => {
      // `undefined` means "not plan work" — the routing rule lives in the agent,
      // and this is the one place a host has to honour it.
      if (await agent.pursueIntent(text)) return;
      await chat(text);
    };
  }

  const status = document.getElementById(opts.statusId ?? "status");
  if (status) {
    // The device line is a bring-up aid that used to be the first thing on
    // screen, which is most of why the app read as a test build. It stays —
    // it is how the Tizen launch-flag fault was found, and on a TV you can't
    // attach a debugger to, "the flag did nothing" and "the flag never
    // arrived" look identical — but only when asked for with `?debug`.
    const search = launchSearch();
    if (debugRequested(search)) {
      status.textContent =
        `${device.model} · ${device.os} ${device.osVersion} · soc=${device.soc}` +
        (opts.detail ? ` · ${opts.detail}` : "") +
        // Redacted: this line put `?key=sk-…` on the television.
        ` · flags:${launchSearchSource()}${redactSecrets(search) || "(none)"}`;
    } else {
      status.remove();
    }
  }

  // Under the avatar the hint is drawn on the canvas; the DOM element is only
  // used by the overlay renderer, which has no canvas to draw on.
  const hint = opts.render === "avatar"
    ? null
    : document.getElementById(opts.hintId ?? "hint");
  // A remote-driven keyboard, so a TV is no longer limited to `?ask=` at launch.
  // Opt-in per host because bring-up runs want the screen to themselves.
  const keyboard = opts.keyboard
    ? mountOnScreenKeyboard({
        onSubmit: (text) => askAndForget(ui, text),
        // Speech goes through the same field, so a transcript can be corrected
        // before sending and both input methods share one place on screen.
        ...(voice ? { onMic: () => void mic?.toggle() } : {}),
        ...(typeof opts.keyboard === "string" ? { layout: opts.keyboard } : {}),
      })
    : undefined;

  /**
   * An on-screen button to start talking, when the keyboard isn't already
   * providing one.
   *
   * Without this, the only ways in were the remote's dedicated voice key and the
   * keyboard's mic key — so a device whose remote has no voice button had no way
   * in at all, and neither did the Android TV emulator, which has no remote of
   * any kind. The hint text said "press the voice button on your remote", which
   * on those devices was simply untrue.
   */
  const micButton = voice && !keyboard
    ? mountMicButton({ onPress: () => void mic?.toggle() })
    : undefined;

  // Owns the flag, the end-of-attempt signal and the backstop timer. Shared with
  // the dev harness, which had its own copy and its own version of the same bug.
  const mic = voice
    ? createListeningState({
        voice,
        onChange: (on) => {
          ui.setListening?.(on);
          micButton?.setListening(on);
        },
      })
    : undefined;

  if (voice && mic) {
    voice.onTranscript((text, isFinal) => {
      // Show it in the field when there is one, so it can be corrected.
      keyboard?.setText(text);
      if (!isFinal) return;
      // `onListeningEnd` will fire too; this is just faster, and the state
      // ignores a repeat.
      void mic.stop();
      // Send it straight away: on a TV, making someone walk to "Send" after
      // speaking defeats the point of speaking.
      if (text.trim()) askAndForget(ui, text.trim());
    });

    document.addEventListener("keydown", (e) => {
      const intent = remoteIntent(e);
      // The remote's own voice button, bound whether or not the keyboard is up.
      if (intent === "mic") {
        e.preventDefault();
        void mic?.toggle();
        return;
      }
      // OK on the mic button. Handled here rather than left to the button's own
      // click handler because a TV WebView does not reliably turn an OK press
      // into a click on a focused element — and when the keyboard is up it owns
      // OK, which is why this is bound only alongside the button.
      if (intent === "press" && micButton) {
        e.preventDefault();
        void mic?.toggle();
      }
    });
    // Android never delivers the voice button to the WebView — it goes to the
    // Activity and on to the system assistant — so the host forwards it here,
    // the same way it forwards BACK. Harmless on platforms that don't call it.
    (globalThis as { __tvVoiceKey?: () => void }).__tvVoiceKey = () => void mic?.toggle();
  }

  if (hint) hint.textContent = hintText;

  if (!keyboard && !micButton) return ui;
  // Tear these down with the shell, so a host that remounts doesn't stack a
  // second listener on document.
  return {
    ...ui,
    destroy: () => { keyboard?.destroy(); micButton?.destroy(); ui.destroy(); },
  };
}

/**
 * Read the keyboard flag: `?keyboard` turns it on, `?keyboard=phrases` turns it
 * on and opens that layout.
 *
 * Returns a fragment to spread into `mountDeviceShell` options, so each host
 * stays a single line instead of three copies of the same regex.
 */
/**
 * Which renderer to use, defaulting to the avatar.
 *
 * The default used to be the unstyled DOM overlay, on the grounds that it needs
 * no canvas — but every host that ships to a viewer has one, and the overlay is
 * what made a freshly installed app look like a test harness. Bring-up asks for
 * it explicitly now with `?render=overlay`, which is the right way round: the
 * plain view is the special case.
 */
export function renderOption(search = launchSearch()): { render: "overlay" | "avatar" } {
  return { render: /(?:^|[?&])render=overlay(?=[&]|$)/.test(search) ? "overlay" : "avatar" };
}

/**
 * How to talk to this device, in one sentence a viewer can act on.
 *
 * Named after what it is for: the old text described the *host's* situation
 * ("No input surface on this host yet — launch with ?ask=…"), which is useful to
 * whoever is bringing the board up and meaningless to whoever is holding the
 * remote. Only the last case still says that, because there genuinely is nothing
 * the viewer can do.
 */
export function inviteText(hasKeyboard: boolean, hasVoice: boolean): string {
  // Every one of these names a control that is actually on screen. The previous
  // voice-only text was "Press the voice button on your remote", which is untrue
  // on a remote without that key and on an emulator with no remote at all — and
  // there was nothing else to press, so the app was unusable rather than merely
  // mislabelled. OK works for a D-pad, an emulator's Enter and a pointer click
  // alike.
  if (hasVoice && hasKeyboard) return "Select 🎤 Speak to talk, or type a command below";
  if (hasVoice) return "Press OK to speak";
  if (hasKeyboard) return "Use the arrow keys and OK to type";
  return "Launch with ?ask=… to run a command, or ?diag for the capability report";
}

/**
 * Whether to show the engineering line. `?debug` on its own, not a prefix match:
 * `?debugger` shouldn't turn it on, the same trap `keyboardOption` already has.
 */
export function debugRequested(search = launchSearch()): boolean {
  return /(?:^|[?&])debug(?=[&=]|$)/.test(search);
}

export function keyboardOption(search = launchSearch()): { keyboard?: boolean | string } {
  // The trailing boundary matters: without it `?keyboardless` would switch the
  // keyboard on, which is the kind of thing nobody notices until it happens.
  const match = /(?:^|[?&])keyboard(?:=([^&]*))?(?=&|$)/.exec(search);
  if (!match) return {};
  const value = match[1];
  return { keyboard: value ? decodeURIComponent(value) : true };
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
    // Same reasoning as `askAndForget`: one bad command must not end the demo
    // loop or raise an unhandled rejection on a TV left running it all day.
    void runDemo((command) => ui.ask(command).catch(() => {}), demo.commands, {
      loop: demo.loop,
      onCommand: (command, i, total) => show(`▶ ${command}   (${i + 1}/${total})`),
      onDone: () => show(demo.loop ? "" : "Demo finished — relaunch with ?demo to run it again."),
    });
    return;
  }

  for (const command of commandsFromUrl(opts.search)) {
    show(`▶ ${command}`);
    // A command that fails is not a boot failure. Hosts wrap this call in the
    // try/catch that paints "Boot error: …", so letting the rejection out
    // replaced a working app with a message blaming startup for a turn that
    // simply didn't work — and the turn's own error is already on screen.
    await ui.ask(command).catch(() => { show(`▶ ${command} — didn't work`); });
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

/**
 * Prefer the 10-foot dialog, then `window.confirm`, then nothing.
 *
 * Built lazily and only once: mounting a modal at import time would put an
 * element on every page that never shows one, and every host would pay for it.
 */
function defaultAsk(): ((question: string) => boolean | Promise<boolean>) | undefined {
  if (typeof document !== "undefined") {
    let dialog: TvConfirmDialog | undefined;
    return (q: string) => (dialog ??= createTvConfirmDialog()).ask(q);
  }
  const w = typeof window !== "undefined" ? (window as Window & { confirm?: unknown }) : undefined;
  return typeof w?.confirm === "function" ? (q: string) => window.confirm(q) : undefined;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args).map(([k, v]) => `${k}=${String(v)}`).join(", ");
}
