import { describe, it, expect } from "vitest";
import { tvThemeCss, tvThemeOptionsFromUrl, TV_PALETTE, TV_FONT } from "./theme.js";

/** Just the `#tv-backdrop` rule — the layer that decides what shows through. */
const backdropRule = (css: string): string => {
  const match = /#tv-backdrop\{([^}]*)\}/.exec(css);
  if (!match) throw new Error("no #tv-backdrop rule in the theme");
  return match[1]!;
};

describe("tvThemeCss", () => {
  it("is opaque unless the host says its window is really see-through", () => {
    // This defaulted to translucent and it was wrong on two hosts out of three:
    // Tizen and webOS give a web app no way to make its window transparent, so
    // the scrim composited over the runtime's own pale backing and the screen
    // came out washed-out grey. Measured on the Tizen emulator.
    expect(backdropRule(tvThemeCss())).not.toContain("rgba");
    expect(backdropRule(tvThemeCss())).not.toContain("backdrop-filter");
  });

  it("still leaves the page itself transparent, so an opted-in host shows through", () => {
    // The canvas used to paint an opaque fill over everything, which is what
    // made an overlay impossible however translucent the native window was. The
    // backdrop layer carries the surface instead, in both modes.
    expect(tvThemeCss()).toContain("background:transparent");
    expect(tvThemeCss({ translucent: true })).toContain("background:transparent");
  });

  it("blurs what's behind once a host opts in", () => {
    const css = tvThemeCss({ translucent: true });
    expect(css).toContain("backdrop-filter:blur");
    // TV Chromium builds are old enough to need the prefix, and shipping only
    // the modern spelling means no blur at all on the devices that need it most.
    expect(css).toContain("-webkit-backdrop-filter:blur");
  });

  it("goes opaque on request, for a bring-up capture", () => {
    const css = tvThemeCss({ translucent: false });
    // Only the backdrop stops blurring. `.tv-glass` keeps its filter: a panel
    // still blurs the app's own content behind it, which is a different thing
    // from letting the channel through.
    expect(backdropRule(css)).not.toContain("backdrop-filter");
    // Still a gradient, not flat black: a single flat fill is most of what made
    // the old screen read as a terminal.
    expect(backdropRule(css)).toContain("radial-gradient");
    // No alpha anywhere in it, or "solid" wouldn't be.
    expect(backdropRule(css)).not.toContain("rgba");
  });

  it("carries the scrim through to the backdrop", () => {
    expect(tvThemeCss({ translucent: true, scrim: 0.9 })).toContain("rgba(6,8,14,0.900)");
  });

  it("dims hard enough by default to read over a bright screen behind", () => {
    // CSS cannot blur another native window, so dimming is the only tool there
    // is. At 0.62 the greeting was genuinely hard to read over the launcher.
    const alpha = /rgba\(6,8,14,([0-9.]+)\)/.exec(tvThemeCss({ translucent: true }))?.[1];
    expect(Number(alpha)).toBeGreaterThanOrEqual(0.8);
  });

  it("clamps a scrim that would make the app invisible or opaque-by-accident", () => {
    expect(tvThemeCss({ translucent: true, scrim: 5 })).toContain("rgba(6,8,14,1.000)");
    expect(tvThemeCss({ translucent: true, scrim: -1 })).toContain("rgba(6,8,14,0.000)");
  });

  it("hides the engineering hint element the hosts still ship in their markup", () => {
    expect(tvThemeCss()).toContain("#hint{display:none}");
  });

  it("publishes the palette as variables so a surface can't invent its own blue", () => {
    const css = tvThemeCss();
    expect(css).toContain(`--tv-accent:${TV_PALETTE.accent}`);
    expect(css).toContain(`--tv-font:${TV_FONT}`);
  });
});

describe("tvThemeOptionsFromUrl", () => {
  it("says nothing unless asked, leaving the host's own answer to stand", () => {
    expect(tvThemeOptionsFromUrl("")).toEqual({});
    expect(tvThemeOptionsFromUrl("?keyboard")).toEqual({});
  });

  it("can force translucency on, for a host that didn't opt in", () => {
    expect(tvThemeOptionsFromUrl("?translucent")).toEqual({ translucent: true });
  });

  it("isn't switched on by a flag that merely starts with 'translucent'", () => {
    expect(tvThemeOptionsFromUrl("?translucency")).toEqual({});
  });

  it("reads ?solid", () => {
    expect(tvThemeOptionsFromUrl("?solid")).toEqual({ translucent: false });
    expect(tvThemeOptionsFromUrl("?render=avatar&solid")).toEqual({ translucent: false });
  });

  it("won't be switched on by a flag that merely starts with 'solid'", () => {
    // Same trap `keyboardOption` already fell into with `?keyboardless`.
    expect(tvThemeOptionsFromUrl("?solidarity")).toEqual({});
  });

  it("reads ?scrim=", () => {
    expect(tvThemeOptionsFromUrl("?scrim=0.3")).toEqual({ scrim: 0.3 });
    expect(tvThemeOptionsFromUrl("?a=1&scrim=1")).toEqual({ scrim: 1 });
  });

  it("ignores a scrim that isn't a number rather than producing NaN CSS", () => {
    expect(tvThemeOptionsFromUrl("?scrim=")).toEqual({});
  });
});
