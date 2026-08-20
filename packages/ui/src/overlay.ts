import type { Agent } from "@hearthkit/core";
import { truncate } from "./format.js";
import { createAgentViewModel, type AgentViewState } from "./view-model.js";

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
 * Minimal, dependency-free 10-foot overlay. It renders the shared
 * `createAgentViewModel` state — status, streamed tokens and tool activity. This
 * is the DOM reference view; on very low-end MTK/NVT GPUs swap it for a
 * Lightning/Blits (WebGL) renderer that consumes the same view-model (see
 * README), so only the drawing differs.
 */
export function mountAgentOverlay(agent: Agent, opts: OverlayOptions = {}): OverlayController {
  if (typeof document === "undefined") {
    throw new Error("mountAgentOverlay requires a DOM environment");
  }
  const mount = opts.mount ?? document.body;
  const showActivity = opts.showActivity ?? true;

  const root = document.createElement("div");
  root.setAttribute("data-hearth-overlay", "");
  root.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;padding:32px;color:#e8eefc;" +
    "font-family:sans-serif;font-size:28px;line-height:1.4;" +
    "background:linear-gradient(transparent,rgba(5,6,10,.92));";
  const reply = document.createElement("div");
  const activity = document.createElement("div");
  activity.style.cssText = "opacity:.6;font-size:20px;margin-top:8px;min-height:24px";
  root.append(reply, activity);
  mount.appendChild(root);

  // --- drawing (the only part specific to this renderer) ---
  function render(state: AgentViewState): void {
    // Streamed text is shown in full; a non-streamed final answer is capped so
    // one long reply can't overflow the screen.
    reply.textContent = state.streamed ? state.reply : truncate(state.reply, 400);
    if (state.error) activity.textContent = "⚠ " + state.error;
    else if (showActivity && state.activity) activity.textContent = "· " + truncate(state.activity);
    else activity.textContent = "";
  }

  const vm = createAgentViewModel(agent);
  vm.subscribe(render);
  render(vm.snapshot());

  return {
    ask: async (input: string) => { await agent.run(input); },
    destroy: () => {
      vm.destroy();
      root.remove();
    },
  };
}
