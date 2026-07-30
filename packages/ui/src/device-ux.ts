import type { Agent, ConfirmRequest } from "@tv-ai-agent/core";
import type { PlatformProvider } from "@tv-ai-agent/platform-api";

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
