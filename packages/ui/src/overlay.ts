import type { Agent } from "@tv-ai-agent/core";
import { formatToolCall, truncate } from "./format.js";

export interface OverlayOptions {
  /** Element to mount into. Defaults to document.body. */
  mount?: HTMLElement;
  /** Show tool-call activity lines. Default true. */
  showActivity?: boolean;
}

export interface OverlayController {
  /** Send a user request to the agent and render the streamed reply. */
  ask(input: string): Promise<void>;
  destroy(): void;
}

/**
 * Minimal, dependency-free 10-foot overlay. It subscribes to the agent's event
 * bus and renders status, streamed tokens and tool activity. This is the DOM
 * reference view; on very low-end MTK/NVT GPUs swap it for a Lightning/Blits
 * (WebGL) renderer that drives the same Agent + events (see README).
 *
 * Rendering is isolated behind `render*` methods so a WebGL view can reuse the
 * exact same event wiring.
 */
export function mountAgentOverlay(agent: Agent, opts: OverlayOptions = {}): OverlayController {
  if (typeof document === "undefined") {
    throw new Error("mountAgentOverlay requires a DOM environment");
  }
  const mount = opts.mount ?? document.body;
  const showActivity = opts.showActivity ?? true;

  const root = document.createElement("div");
  root.setAttribute("data-tv-agent-overlay", "");
  root.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;padding:32px;color:#e8eefc;" +
    "font-family:sans-serif;font-size:28px;line-height:1.4;" +
    "background:linear-gradient(transparent,rgba(5,6,10,.92));";
  const reply = document.createElement("div");
  const activity = document.createElement("div");
  activity.style.cssText = "opacity:.6;font-size:20px;margin-top:8px;min-height:24px";
  root.append(reply, activity);
  mount.appendChild(root);

  // --- event wiring (identical for any view implementation) ---
  const unsub: Array<() => void> = [];
  unsub.push(agent.events.on("turn:start", () => { reply.textContent = ""; activity.textContent = ""; }));
  unsub.push(agent.events.on("token", ({ delta }) => { reply.textContent += delta; }));
  unsub.push(agent.events.on("tool:call", ({ name, args }) => {
    if (showActivity) activity.textContent = "· " + truncate(formatToolCall(name, args));
  }));
  unsub.push(agent.events.on("tool:result", () => { /* keep last activity line */ }));
  unsub.push(agent.events.on("turn:end", ({ output }) => {
    if (!reply.textContent) reply.textContent = truncate(output, 400);
    activity.textContent = "";
  }));
  unsub.push(agent.events.on("error", ({ error }) => { activity.textContent = "⚠ " + error.message; }));

  return {
    ask: async (input: string) => { await agent.run(input); },
    destroy: () => {
      unsub.forEach((u) => u());
      root.remove();
    },
  };
}
