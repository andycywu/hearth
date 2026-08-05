/**
 * One visual language for all four hosts.
 *
 * Each host shipped its own `<style>` block, written before there was an avatar,
 * a keyboard or a dialog — so the app looked like four different test harnesses
 * and every new surface had to re-invent a colour. This is the single place that
 * decides what the agent looks like, injected at runtime so a host adopts it
 * without editing its markup.
 *
 * Two things drive the design:
 *
 *  - **It is an overlay, not an app.** A TV agent appears over whatever you were
 *    watching, so the default surface is translucent and blurred rather than a
 *    flat page. On a host that can't be see-through the same tokens still read as
 *    frosted glass over its own dark backdrop, so nothing looks broken.
 *  - **It is read from three metres away.** Sizes are in `vh`, so they scale with
 *    the panel from 720p to 4K instead of being pinned to a 1080p mock, and
 *    nothing informational is smaller than ~2.2vh.
 */

/** The palette. Exported so canvas drawing can match the CSS exactly. */
export const TV_PALETTE = {
  /** Primary text. Not pure white: it blooms on an OLED at this size. */
  text: "#eef3fb",
  muted: "rgba(238,243,251,.62)",
  faint: "rgba(238,243,251,.34)",
  /** Interactive/live. The one colour that must read at a glance. */
  accent: "#6cb6ff",
  /** Surfaces, over whatever is behind the app. */
  glass: "rgba(255,255,255,.07)",
  glassStrong: "rgba(20,26,38,.82)",
  edge: "rgba(255,255,255,.12)",
  danger: "#ff9a9a",
} as const;

/**
 * The font stack, shared by the CSS and by canvas drawing so the avatar's text
 * and the keyboard's text are the same face. TV WebViews have no consistent
 * default: bare `sans-serif` gave three different faces on three devices.
 */
export const TV_FONT =
  '"Noto Sans","Roboto","Helvetica Neue",Helvetica,Arial,sans-serif';

export interface TvThemeOptions {
  /**
   * Let whatever is behind the app show through. Default true.
   *
   * Set false for bring-up captures and screenshots, where a translucent window
   * over a live channel makes it impossible to tell whether the app drew
   * anything at all.
   */
  translucent?: boolean;
  /**
   * Scrim opacity over the content behind, 0..1. Default 0.86.
   *
   * That is heavier than it looks like it should be, and deliberately so. On a
   * translucent native window the content behind is *another window*, which CSS
   * cannot blur — `backdrop-filter` only ever sees the page's own content. So
   * dimming is the only tool available for keeping our text legible, and at 0.62
   * a bright screen behind the app made the greeting genuinely hard to read.
   * `?scrim=0.4` if you would rather see more of the channel.
   */
  scrim?: number;
}

/**
 * The stylesheet, as text. Pure, so the tokens can be asserted in a test
 * environment with no DOM.
 */
export function tvThemeCss(opts: TvThemeOptions = {}): string {
  const translucent = opts.translucent ?? true;
  const scrim = clamp01(opts.scrim ?? 0.86);
  const p = TV_PALETTE;

  // Opaque mode still uses a gradient rather than flat black: a single flat fill
  // is most of what made the old screen look like a terminal.
  const backdrop = translucent
    ? `radial-gradient(120% 120% at 50% 0%, rgba(28,38,60,${(scrim * 0.55).toFixed(3)}) 0%, ` +
      `rgba(6,8,14,${scrim.toFixed(3)}) 60%, rgba(4,5,9,${Math.min(1, scrim + 0.12).toFixed(3)}) 100%)`
    : `radial-gradient(120% 120% at 50% 0%, #131a29 0%, #070910 60%, #04050a 100%)`;

  return [
    `:root{`,
    `--tv-text:${p.text};--tv-muted:${p.muted};--tv-faint:${p.faint};`,
    `--tv-accent:${p.accent};--tv-glass:${p.glass};--tv-glass-strong:${p.glassStrong};`,
    `--tv-edge:${p.edge};--tv-danger:${p.danger};`,
    `--tv-font:${TV_FONT};`,
    `}`,
    // The window itself is see-through; the backdrop layer below provides the
    // surface. Colouring `body` instead would defeat a translucent native window.
    `html,body{margin:0;height:100%;background:transparent;color:var(--tv-text);`,
    `font-family:var(--tv-font);-webkit-font-smoothing:antialiased;overflow:hidden}`,
    `#tv-backdrop{position:fixed;inset:0;z-index:-1;background:${backdrop};`,
    // A blur here only affects the page's own content, never the window behind —
    // that is a browser-level limit, not a missing flag. It is still worth
    // asking for: on a host where the app is *not* over a native window (the
    // browser harness, an embedded WebView with a page behind it) it does apply,
    // and where it doesn't, it costs nothing. What actually keeps our text
    // readable over a live channel is the scrim above. Both spellings, because TV
    // Chromium builds are old enough to need the prefix.
    translucent ? `-webkit-backdrop-filter:blur(2.2vh) saturate(115%);backdrop-filter:blur(2.2vh) saturate(115%)}` : `}`,
    // Nothing is focusable by pointer on a TV, and the default focus ring on a
    // WebView is a hairline nobody can see from a sofa.
    `*:focus{outline:none}`,
    // Shared surface treatment for the keyboard, the dialog and any panel added
    // later — one definition so they can't drift apart.
    `.tv-glass{background:var(--tv-glass-strong);border:1px solid var(--tv-edge);`,
    `border-radius:1.4vh;-webkit-backdrop-filter:blur(1.6vh);backdrop-filter:blur(1.6vh)}`,
    // The old engineering status line, kept but demoted: it earned its place
    // during bring-up (it is how the Tizen launch-flag fault was found) and is
    // now behind `?debug` instead of being the first thing a viewer reads.
    `#status{position:fixed;left:2.4vw;top:2vh;right:2.4vw;font-size:1.7vh;`,
    `line-height:1.5;color:var(--tv-faint);font-family:ui-monospace,monospace;`,
    `white-space:pre-wrap;z-index:3}`,
    `#hint{display:none}`,
  ].join("");
}

/**
 * Inject the theme, once. Returns the `<style>` element so a host can remove it.
 *
 * Idempotent: hosts call this before mounting, and a remount must not stack a
 * second copy.
 */
export function applyTvTheme(opts: TvThemeOptions = {}): HTMLStyleElement {
  if (typeof document === "undefined") {
    throw new Error("applyTvTheme requires a DOM environment");
  }
  const existing = document.getElementById("tv-theme");
  const style = (existing as HTMLStyleElement | null) ?? document.createElement("style");
  style.id = "tv-theme";
  style.textContent = tvThemeCss(opts);
  if (!existing) document.head.appendChild(style);

  if (!document.getElementById("tv-backdrop")) {
    const backdrop = document.createElement("div");
    backdrop.id = "tv-backdrop";
    document.body.insertBefore(backdrop, document.body.firstChild);
  }
  return style;
}

/**
 * Theme options from the page URL, so a device can be re-skinned without a
 * rebuild — `?solid` for a capture, `?scrim=0.3` to see more of the channel.
 */
export function tvThemeOptionsFromUrl(search: string): TvThemeOptions {
  const opts: TvThemeOptions = {};
  if (/(?:^|[?&])solid(?=[&=]|$)/.test(search)) opts.translucent = false;
  const scrim = /(?:^|[?&])scrim=([0-9.]+)/.exec(search);
  if (scrim) {
    const value = Number(scrim[1]);
    if (Number.isFinite(value)) opts.scrim = clamp01(value);
  }
  return opts;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
