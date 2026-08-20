import type { Agent } from "@hearthkit/core";
import { truncate } from "./format.js";
import { wrapLines } from "./wrap.js";
import { createAgentViewModel, type AgentViewState } from "./view-model.js";

export interface CanvasOptions {
  /** Element to mount into. Defaults to document.body. */
  mount?: HTMLElement;
  /** Logical width/height; defaults to the mount/client size. */
  width?: number;
  height?: number;
}

export interface CanvasController {
  ask(input: string): Promise<void>;
  destroy(): void;
}

/**
 * Single-surface (2D canvas) renderer for the agent — an alternative to the DOM
 * overlay that draws everything onto one canvas, avoiding DOM reflow. This is
 * the pattern that keeps a 10-foot UI smooth on low-end MTK/NVT GPUs; the
 * production path replaces the 2D context with a WebGL renderer (Lightning 3 /
 * Blits) while consuming the same `createAgentViewModel` state.
 */
export function mountAgentCanvas(agent: Agent, opts: CanvasOptions = {}): CanvasController {
  if (typeof document === "undefined") {
    throw new Error("mountAgentCanvas requires a DOM environment");
  }
  const mount = opts.mount ?? document.body;
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const canvas = document.createElement("canvas");
  const cssW = opts.width ?? mount.clientWidth ?? 1280;
  const cssH = opts.height ?? mount.clientHeight ?? 720;
  canvas.style.cssText = `width:${cssW}px;height:${cssH}px;display:block`;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  mount.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  const vm = createAgentViewModel(agent);
  let state: AgentViewState = vm.snapshot();
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  };

  function draw(): void {
    ctx.clearRect(0, 0, cssW, cssH);
    // backdrop
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, cssW, cssH);

    const pad = Math.round(cssW * 0.04);
    const maxW = cssW - pad * 2;

    // reply (large)
    ctx.fillStyle = "#e8eefc";
    const replyFont = Math.round(cssH * 0.05);
    ctx.font = `${replyFont}px sans-serif`;
    const measure = (s: string) => ctx.measureText(s).width;
    const lines = wrapLines(measure, state.reply, maxW).slice(-4);
    let y = cssH - pad - (state.activity || state.error ? replyFont : 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      ctx.fillText(lines[i]!, pad, y);
      y -= replyFont * 1.3;
    }

    // activity / error (small, bottom)
    const smallFont = Math.round(cssH * 0.03);
    ctx.font = `${smallFont}px sans-serif`;
    if (state.error) {
      ctx.fillStyle = "#ff9a9a";
      ctx.fillText(truncate("⚠ " + state.error, 80), pad, cssH - pad + smallFont);
    } else if (state.activity) {
      ctx.fillStyle = "rgba(232,238,252,.6)";
      ctx.fillText(truncate("· " + state.activity, 80), pad, cssH - pad + smallFont);
    }
  }

  // One coalesced repaint per frame, however many events arrived — token streams
  // fire far faster than the panel refreshes.
  vm.subscribe((next) => { state = next; schedule(); });

  draw();

  return {
    ask: async (input: string) => { await agent.run(input); },
    destroy: () => {
      vm.destroy();
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}
