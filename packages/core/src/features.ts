/**
 * Which optional parts of the runtime a build contains.
 *
 * A television is not a laptop: the bundle is parsed by a WebView that may be
 * several Chromium releases behind, on a launcher's memory budget, every single
 * launch. So "is this feature in the build?" has to be answered at *build* time.
 * An on-screen keyboard nobody opens still costs 5.8 KB of parse on every boot.
 *
 * `tools/bundle.mjs` replaces these with `esbuild` `define`, and a `false` folds
 * the guarded branch away — taking the feature and **everything it imports**
 * with it. Measured on the ModelPilot planner: 17.4 KB → 0.1 KB.
 *
 * ## How to guard something
 *
 * Inline, at the use site, exactly like this:
 *
 * ```ts
 * if (typeof __HEARTH_DIAG__ === "undefined" || __HEARTH_DIAG__) {
 *   await showDiagnostics(platform);
 * }
 * ```
 *
 * It has to be the `define`d identifier *in the branch itself*. Re-exporting it
 * as `export const HAS_DIAG = __HEARTH_DIAG__` and branching on that reads
 * better and **does not work**: esbuild substitutes defines per file and does not
 * inline a `const` across module boundaries, so the import survives and the
 * feature ships anyway. That was measured too — 17.4 KB either way.
 *
 * The `typeof … === "undefined" ||` half is what keeps the same source running
 * *unbundled*: in vitest, in the CLI, under `tsx`, nothing is defined and every
 * optional feature is simply present. esbuild folds it to a constant, so it is
 * free in a real build.
 */

declare global {
  /** `?diag` — the on-screen capability report and the write probes behind it. */
  const __HEARTH_DIAG__: boolean | undefined;
  /**
   * The offline scripted brain: a keyword matcher, not a model. It was the
   * largest single thing in the shipped bundle — 11 KB, 9% — carried by every
   * television so a set with no endpoint could still appear to answer. A build
   * without it says it has no model, which is the truth.
   */
  const __HEARTH_OFFLINE__: boolean | undefined;
  /** The ModelPilot decision engine. Inert without a credential — but 14.6 KB of inert. */
  const __HEARTH_MODELPILOT__: boolean | undefined;
  /** The animated face. `?render=overlay` is the plain view that replaces it. */
  const __HEARTH_AVATAR__: boolean | undefined;
  /** The remote-driven on-screen keyboard, only ever shown behind `?keyboard`. */
  const __HEARTH_KEYBOARD__: boolean | undefined;
  /** `?demo` / `?ask=` — the self-running script for a booth or a bring-up. */
  const __HEARTH_DEMO__: boolean | undefined;
}

/** Reads the flags for a log line. Never branch on this — see the note above. */
export function featureFlags(): Record<string, boolean> {
  const on = (v: boolean | undefined): boolean => v === undefined || v;
  return {
    diag: on(typeof __HEARTH_DIAG__ === "undefined" ? undefined : __HEARTH_DIAG__),
    offline: on(typeof __HEARTH_OFFLINE__ === "undefined" ? undefined : __HEARTH_OFFLINE__),
    modelpilot: on(typeof __HEARTH_MODELPILOT__ === "undefined" ? undefined : __HEARTH_MODELPILOT__),
    avatar: on(typeof __HEARTH_AVATAR__ === "undefined" ? undefined : __HEARTH_AVATAR__),
    keyboard: on(typeof __HEARTH_KEYBOARD__ === "undefined" ? undefined : __HEARTH_KEYBOARD__),
    demo: on(typeof __HEARTH_DEMO__ === "undefined" ? undefined : __HEARTH_DEMO__),
  };
}

/** `diag demo modelpilot` — what this build has, for one line in a boot log. */
export function describeFeatures(): string {
  const on = Object.entries(featureFlags()).filter(([, v]) => v).map(([k]) => k);
  return on.length ? on.join(" ") : "minimal";
}
