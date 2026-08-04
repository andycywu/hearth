import type { Agent } from "@tv-ai-agent/core";
import { truncate } from "./format.js";
import { wrapLines } from "./wrap.js";
import { createAgentViewModel, type AgentPhase, type AgentViewState } from "./view-model.js";

/**
 * The agent's face: an abstract form that shows what it is doing.
 *
 * Drawn in code rather than from artwork, for three reasons that all matter on a
 * TV — nothing to download or license, it stays sharp at any panel resolution
 * from 720p to 4K, and a handful of arcs is cheap enough for the weakest MTK/NVT
 * GPU. The four phases read from across a room: still, reaching out, turning
 * inward, talking.
 *
 * The geometry is `avatarFrame()`, a pure function, so the motion can be tested
 * without a canvas and reused by the WebGL renderer later.
 */

/** Everything needed to draw one frame. Numbers are normalized 0..1. */
export interface AvatarFrame {
  /** Core radius as a fraction of the available radius. */
  coreScale: number;
  /** Expanding rings, each a 0..1 progress from the core outward. */
  rings: readonly number[];
  /** Rotation of the thinking arcs, in radians. */
  spin: number;
  /** How much of the arc ring is drawn, 0..1. Zero hides it. */
  arcSweep: number;
  /** Colour of the form for this phase. */
  color: string;
  /** Outer glow strength, 0..1. */
  glow: number;
}

const COLORS: Record<AgentPhase, string> = {
  // Muted enough to sit behind content without competing with it.
  idle: "#5b6b8c",
  // Unmistakably "live" — this is the state that must be readable at a glance.
  listening: "#4da3ff",
  thinking: "#a78bfa",
  // Warm, so speech feels different in kind from listening rather than louder.
  speaking: "#f5f0e6",
};

export interface AvatarFrameOptions {
  /**
   * Hold the form still. Honour `prefers-reduced-motion`, and useful on a panel
   * where continuous animation is unwelcome. The phase is still legible by
   * colour and by whether the rings/arcs are present.
   */
  reducedMotion?: boolean;
  /**
   * 0..1 speech energy, if the host has it. Without a real envelope the mouth
   * still moves — `speaking` synthesises motion — but a live level looks better.
   */
  level?: number;
}

/**
 * Geometry for the form at time `tMs`. Pure: same inputs, same frame.
 *
 * Deliberately not driven by real audio analysis. A TV host may not be able to
 * tap the TTS output at all (Tizen and webOS both hand playback to the platform),
 * so the default has to look right with nothing but a clock.
 */
export function avatarFrame(
  phase: AgentPhase,
  tMs: number,
  opts: AvatarFrameOptions = {},
): AvatarFrame {
  const color = COLORS[phase];
  if (opts.reducedMotion) {
    // Still, but not identical between phases — colour and the presence of rings
    // or arcs carry the state on their own.
    return {
      coreScale: phase === "listening" ? 0.62 : 0.55,
      rings: phase === "listening" ? [0.5] : [],
      spin: 0,
      arcSweep: phase === "thinking" ? 0.75 : 0,
      color,
      glow: phase === "idle" ? 0.2 : 0.5,
    };
  }

  const t = tMs / 1000;
  switch (phase) {
    case "idle": {
      // Slow breath, ~6s a cycle: present without asking for attention.
      const breath = Math.sin((t * Math.PI * 2) / 6);
      return {
        coreScale: 0.53 + breath * 0.03,
        rings: [],
        spin: 0,
        arcSweep: 0,
        color,
        glow: 0.18 + breath * 0.06,
      };
    }
    case "listening": {
      // Rings travelling outward — energy leaving the form, i.e. reaching for
      // the room. Three staggered so there is always one mid-flight.
      const period = 1.6;
      const rings = [0, 1, 2].map((i) => ((t / period) + i / 3) % 1);
      const pulse = Math.sin((t * Math.PI * 2) / 0.8);
      return {
        coreScale: 0.6 + pulse * 0.04,
        rings,
        spin: 0,
        arcSweep: 0,
        color,
        glow: 0.55 + pulse * 0.15,
      };
    }
    case "thinking": {
      // Rotation with no outward travel: work happening inside, nothing said yet.
      return {
        coreScale: 0.5,
        rings: [],
        spin: (t * Math.PI * 2) / 2.4,
        arcSweep: 0.7,
        color,
        glow: 0.4,
      };
    }
    case "speaking": {
      // Two detuned components so the wobble doesn't read as a clean sine, which
      // looks mechanical. A supplied level scales it; otherwise it self-drives.
      const a = Math.sin(t * Math.PI * 2 * 3.1);
      const b = Math.sin(t * Math.PI * 2 * 5.7 + 1.1);
      const energy = opts.level ?? 0.65 + 0.35 * ((a + b) / 2);
      const amp = clamp01(energy);
      return {
        coreScale: 0.52 + amp * 0.16,
        rings: [],
        spin: 0,
        arcSweep: 0,
        color,
        glow: 0.35 + amp * 0.4,
      };
    }
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export interface AvatarOptions {
  /** Element to mount into. Defaults to document.body. */
  mount?: HTMLElement;
  /** Logical size; defaults to the mount/client size. */
  width?: number;
  height?: number;
  /** Force still motion. Defaults to the `prefers-reduced-motion` media query. */
  reducedMotion?: boolean;
  /** Draw the reply and activity text under the form. Default true. */
  showText?: boolean;
}

export interface AvatarController {
  ask(input: string): Promise<void>;
  /** Tell the avatar the microphone is open. */
  setListening(listening: boolean): void;
  /** Tell the avatar text-to-speech is playing. */
  setSpeaking(speaking: boolean): void;
  /** Optional live speech energy, 0..1, when the host can measure it. */
  setLevel(level: number | undefined): void;
  destroy(): void;
}

/**
 * Mount the avatar on a 2D canvas, driven entirely by agent events.
 *
 * It owns no state of its own beyond the animation clock: everything it shows
 * comes from `createAgentViewModel`, so it behaves identically under the offline
 * scripted brain and a real model, on every platform.
 */
export function mountAgentAvatar(agent: Agent, opts: AvatarOptions = {}): AvatarController {
  if (typeof document === "undefined") {
    throw new Error("mountAgentAvatar requires a DOM environment");
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

  const reducedMotion = opts.reducedMotion ?? prefersReducedMotion();
  const showText = opts.showText ?? true;

  const vm = createAgentViewModel(agent);
  let state: AgentViewState = vm.snapshot();
  let level: number | undefined;
  let raf = 0;
  const started = now();

  function draw(): void {
    const frame = avatarFrame(state.phase, now() - started, {
      reducedMotion,
      ...(level !== undefined ? { level } : {}),
    });

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, cssW, cssH);

    // The form sits in the upper half so subtitles have the lower half, which is
    // where a viewer's eyes already are on a TV.
    const cx = cssW / 2;
    const cy = cssH * (showText ? 0.36 : 0.5);
    const maxR = Math.min(cssW, cssH) * (showText ? 0.16 : 0.28);

    // Travelling rings first, so the core sits on top of them.
    for (const p of frame.rings) {
      const r = maxR * (0.6 + p * 1.6);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(frame.color, (1 - p) * 0.5);
      ctx.lineWidth = Math.max(1, maxR * 0.05 * (1 - p));
      ctx.stroke();
    }

    // Rotating arcs for thinking.
    if (frame.arcSweep > 0) {
      const r = maxR * 0.85;
      for (const offset of [0, Math.PI]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, frame.spin + offset, frame.spin + offset + Math.PI * frame.arcSweep * 0.5);
        ctx.strokeStyle = withAlpha(frame.color, 0.8);
        ctx.lineWidth = Math.max(2, maxR * 0.08);
        ctx.stroke();
      }
    }

    // Glow, then core.
    const coreR = maxR * frame.coreScale;
    if (frame.glow > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(frame.color, frame.glow * 0.25);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(frame.color, 0.95);
    ctx.fill();

    if (showText) drawText();
  }

  function drawText(): void {
    const pad = Math.round(cssW * 0.06);
    const maxW = cssW - pad * 2;
    const replyFont = Math.round(cssH * 0.055);
    ctx.font = `${replyFont}px sans-serif`;
    ctx.textAlign = "center";
    const measure = (s: string) => ctx.measureText(s).width;
    const lines = wrapLines(measure, state.reply, maxW).slice(-3);

    ctx.fillStyle = "#e8eefc";
    let y = cssH * 0.68;
    for (const line of lines) {
      ctx.fillText(line, cssW / 2, y);
      y += replyFont * 1.3;
    }

    const smallFont = Math.round(cssH * 0.032);
    ctx.font = `${smallFont}px sans-serif`;
    if (state.error) {
      ctx.fillStyle = "#ff9a9a";
      ctx.fillText(truncate("⚠ " + state.error, 80), cssW / 2, cssH - pad);
    } else if (state.activity) {
      ctx.fillStyle = "rgba(232,238,252,.6)";
      ctx.fillText(truncate("· " + state.activity, 80), cssW / 2, cssH - pad);
    }
    ctx.textAlign = "start";
  }

  /**
   * Animate only while there is motion to show. A still form doesn't need a
   * frame budget, and an idle TV shouldn't be spinning the GPU for nothing —
   * but `idle` does breathe, so the loop stops only under reduced motion.
   */
  function loop(): void {
    raf = 0;
    draw();
    if (!reducedMotion) raf = requestAnimationFrame(loop);
  }

  vm.subscribe((next) => {
    state = next;
    // Under reduced motion nothing re-arms the loop, so repaint on change.
    if (reducedMotion) draw();
  });

  if (reducedMotion) draw();
  else loop();

  return {
    ask: async (input: string) => { await agent.run(input); },
    setListening: (l) => vm.setListening(l),
    setSpeaking: (s) => vm.setSpeaking(s),
    setLevel: (l) => { level = l; },
    destroy: () => {
      vm.destroy();
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** `#rrggbb` + alpha → `rgba(...)`. Avoids a colour library for four constants. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${clamp01(alpha).toFixed(3)})`;
}
