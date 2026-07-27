import type { Agent } from "@tv-ai-agent/core";
import { formatToolCall, truncate } from "./format.js";
import { wrapLines } from "./wrap.js";

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
 * Blits) while reusing the identical agent-event wiring below.
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

  const state = { reply: "", activity: "", error: "" };
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

  const unsub: Array<() => void> = [];
  unsub.push(agent.events.on("turn:start", () => { state.reply = ""; state.activity = ""; state.error = ""; schedule(); }));
  unsub.push(agent.events.on("token", ({ delta }) => { state.reply += delta; schedule(); }));
  unsub.push(agent.events.on("tool:call", ({ name, args }) => { state.activity = formatToolCall(name, args); schedule(); }));
  unsub.push(agent.events.on("turn:end", ({ output }) => {
    if (!state.reply) state.reply = output;
    state.activity = "";
    schedule();
  }));
  unsub.push(agent.events.on("error", ({ error }) => { state.error = error.message; schedule(); }));

  draw();

  return {
    ask: async (input: string) => { await agent.run(input); },
    destroy: () => {
      unsub.forEach((u) => u());
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}
