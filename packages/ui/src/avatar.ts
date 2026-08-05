import type { Agent } from "@tv-ai-agent/core";
import { truncate } from "./format.js";
import { wrapLines } from "./wrap.js";
import { createAgentViewModel, type AgentPhase, type AgentViewState } from "./view-model.js";
import { TV_PALETTE, TV_FONT as FONT } from "./theme.js";

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
  // Muted enough to sit over content without competing with it, but not the
  // near-grey it used to be — at rest this is the only thing on screen, and a
  // dead grey disc is what made the app look unfinished.
  idle: "#7d90b6",
  // Unmistakably "live" — this is the state that must be readable at a glance.
  // Same blue as the theme accent, so "the app is listening" and "this key is
  // focused" are visibly the same idea.
  listening: "#6cb6ff",
  thinking: "#b39dfb",
  // Warm, so speech differs from listening in kind rather than in brightness —
  // which also keeps the two apart for a red/green colour-blind viewer.
  speaking: "#f4c98a",
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
  /**
   * What to say before anything has been said, in place of the reply. Pass "" to
   * leave the space empty. Default: an invitation to speak.
   */
  greeting?: string;
  /** How to talk to it, under the greeting. Shown only alongside the greeting. */
  hint?: string;
  /**
   * Show the tool call in flight along the bottom edge. Default false.
   *
   * It is the raw call — `set_input_source(source=hdmi1)` — which is exactly
   * what bring-up wants and exactly what a viewer shouldn't be reading. The
   * phase pill already says the agent is working, so nothing is lost by leaving
   * this to `?debug`. Errors are always shown: those are actionable.
   */
  showActivity?: boolean;
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
  const greeting = opts.greeting ?? "How can I help?";
  const hint = opts.hint ?? "";
  const showActivity = opts.showActivity ?? false;

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

    // Cleared to *transparent*, not filled. The canvas used to paint an opaque
    // `#05060a` over the whole layer, which made the app impossible to show over
    // live content however translucent the window was. The backdrop is the
    // theme's job now; the avatar draws only the agent.
    ctx.clearRect(0, 0, cssW, cssH);

    // The form sits in the upper half so subtitles have the lower half, which is
    // where a viewer's eyes already are on a TV.
    const cx = cssW / 2;
    const cy = cssH * (showText ? 0.36 : 0.5);
    const maxR = Math.min(cssW, cssH) * (showText ? 0.21 : 0.3);

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
    //
    // Both are gradients rather than flat discs. A flat circle of one colour is
    // most of what made this read as a debug placeholder — the form is the only
    // thing on screen most of the time, so it has to look deliberate.
    const coreR = maxR * frame.coreScale;
    if (frame.glow > 0) {
      const glowR = coreR * 2.6;
      const halo = ctx.createRadialGradient(cx, cy, coreR * 0.6, cx, cy, glowR);
      halo.addColorStop(0, withAlpha(frame.color, frame.glow * 0.42));
      halo.addColorStop(0.55, withAlpha(frame.color, frame.glow * 0.12));
      halo.addColorStop(1, withAlpha(frame.color, 0));
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fillStyle = halo;
      ctx.fill();
    }
    // Lit from above-left, which is enough to make a sphere out of a circle.
    const body = ctx.createRadialGradient(
      cx - coreR * 0.35, cy - coreR * 0.4, coreR * 0.1,
      cx, cy, coreR,
    );
    body.addColorStop(0, withAlpha(lighten(frame.color, 0.45), 0.98));
    body.addColorStop(0.6, withAlpha(frame.color, 0.96));
    body.addColorStop(1, withAlpha(darken(frame.color, 0.35), 0.94));
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();

    if (showText) drawText(cx, cy + coreR);
  }

  /**
   * What the agent is doing, in words, under the form.
   *
   * The colour and motion say it too, but only to someone who already knows the
   * vocabulary. "Listening" is unambiguous to everyone, and it is the difference
   * between a viewer waiting confidently and pressing the button again.
   */
  const PHASE_LABEL: Record<AgentPhase, string> = {
    idle: "",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking",
  };

  /** Draws the pill and returns its bottom edge, or `top` when there isn't one. */
  function drawPhasePill(cx: number, top: number, color: string): number {
    const label = PHASE_LABEL[state.phase];
    if (!label) return top;
    const font = Math.round(cssH * 0.026);
    ctx.font = `${font}px ${FONT}`;
    const padX = font * 0.9;
    const w = ctx.measureText(label).width + padX * 2;
    const h = font * 2.1;
    const x = cx - w / 2;
    const y = top + cssH * 0.035;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = withAlpha(color, 0.16);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, 0.45);
    ctx.lineWidth = Math.max(1, cssH * 0.0015);
    ctx.stroke();
    ctx.fillStyle = withAlpha(lighten(color, 0.25), 0.95);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, y + h / 2 + font * 0.05);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "start";
    return y + h;
  }

  function drawText(cx: number, orbBottom: number): void {
    const frameColor = COLORS[state.phase];
    const pillBottom = drawPhasePill(cx, orbBottom, frameColor);
    // Below the pill, not at a fixed fraction of the height. A fixed position
    // put "Listening…" hard against the cap-height of the greeting — and it
    // would collide outright on a shorter layer, which is exactly what the
    // keyboard produces.
    const textTop = Math.max(cssH * 0.6, pillBottom + cssH * 0.055);

    const pad = Math.round(cssW * 0.06);
    const maxW = cssW - pad * 2;
    ctx.textAlign = "center";
    const measure = (s: string) => ctx.measureText(s).width;

    if (state.reply) {
      const replyFont = Math.round(cssH * 0.055);
      ctx.font = `${replyFont}px ${FONT}`;
      const lines = wrapLines(measure, state.reply, maxW).slice(-3);
      ctx.fillStyle = TV_PALETTE.text;
      let y = textTop + replyFont;
      for (const line of lines) {
        ctx.fillText(line, cx, y);
        y += replyFont * 1.3;
      }
    } else if (greeting) {
      // Nothing said yet. An empty screen with a dot on it reads as "not
      // working"; a question reads as "your turn". This is the whole reason the
      // greeting lives on the canvas rather than in the host's markup — it has
      // to disappear the instant there is a real reply to show instead.
      const greetFont = Math.round(cssH * 0.062);
      ctx.font = `${greetFont}px ${FONT}`;
      ctx.fillStyle = TV_PALETTE.text;
      let y = textTop + greetFont;
      for (const line of wrapLines(measure, greeting, maxW)) {
        ctx.fillText(line, cx, y);
        y += greetFont * 1.25;
      }
      // Only at rest. "Press OK to speak" is stale advice once the microphone is
      // already open, and the pill is saying what is happening instead.
      if (hint && state.phase === "idle") {
        const hintFont = Math.round(cssH * 0.03);
        ctx.font = `${hintFont}px ${FONT}`;
        ctx.fillStyle = TV_PALETTE.muted;
        y += hintFont * 0.6;
        for (const line of wrapLines(measure, hint, maxW * 0.8)) {
          ctx.fillText(line, cx, y);
          y += hintFont * 1.4;
        }
      }
    }

    const smallFont = Math.round(cssH * 0.03);
    ctx.font = `${smallFont}px ${FONT}`;
    if (state.error) {
      ctx.fillStyle = TV_PALETTE.danger;
      ctx.fillText(truncate("⚠ " + state.error, 80), cx, cssH - pad);
    } else if (state.activity && showActivity) {
      ctx.fillStyle = TV_PALETTE.faint;
      ctx.fillText(truncate(state.activity, 80), cx, cssH - pad);
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
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${clamp01(alpha).toFixed(3)})`;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix towards white / black by `amount`, for the sphere's shading. */
function lighten(hex: string, amount: number): string {
  return mix(hex, 255, amount);
}

function darken(hex: string, amount: number): string {
  return mix(hex, 0, amount);
}

function mix(hex: string, target: number, amount: number): string {
  const a = clamp01(amount);
  const channel = (c: number) => Math.round(c + (target - c) * a);
  const [r, g, b] = rgb(hex);
  return `#${[channel(r), channel(g), channel(b)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * A rounded rectangle path.
 *
 * Hand-rolled because `CanvasRenderingContext2D.roundRect` is far newer than the
 * Chromium in a shipped TV, and calling it there throws mid-frame.
 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}
