import { describe, it, expect, beforeAll } from "vitest";
import { build } from "esbuild";
import { resolve } from "node:path";

/**
 * The feature flags either remove code from the bundle or they are decoration.
 *
 * This is the test that decides which. It builds the real Android entry the way
 * `tools/bundle.mjs` does and weighs the result, because every cheaper check
 * lies: the guards typecheck whether or not they work, the unit tests run
 * unbundled where every feature is present by definition, and a `?diag` that
 * still parses 7.9 KB before deciding not to run behaves exactly like one that
 * was stripped.
 *
 * It also pins the *mechanism*. An earlier attempt read much better —
 * `export const HAS_DIAG = __HEARTH_DIAG__`, branch on that — and removed
 * nothing at all, because esbuild substitutes defines per file and does not
 * inline a const across module boundaries. The bundle came out the same size
 * either way, silently. Only weighing it caught that, and only weighing it will
 * catch the next person tidying the guards into something readable.
 */

const ENTRY = resolve(import.meta.dirname, "../../../apps/aosp-app/web/main.ts");
const FEATURES = ["diag", "offline", "modelpilot", "avatar", "keyboard", "demo"] as const;

/** What `tools/bundle.mjs` ships unless told otherwise. Keep the two in step. */
const DEFAULT_PROFILE: Record<string, boolean> = {
  diag: false, offline: false, modelpilot: true, avatar: true, keyboard: false, demo: false,
};

interface Built { bytes: number; inputs: string[] }

async function bundle(features: Record<string, boolean>): Promise<Built> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true, format: "esm", platform: "browser", target: ["es2020"],
    minify: true, metafile: true, write: false, legalComments: "none",
    define: Object.fromEntries(
      Object.entries(features).map(([k, v]) => [`__HEARTH_${k.toUpperCase()}__`, String(v)]),
    ),
  });
  const out = Object.values(result.metafile.outputs).find((o) => o.entryPoint);
  if (!out) throw new Error("esbuild produced no entry output");
  return {
    bytes: out.bytes,
    inputs: Object.keys(out.inputs).map((p) => p.split("\\").join("/")),
  };
}

const all = (on: boolean): Record<string, boolean> =>
  Object.fromEntries(FEATURES.map((f) => [f, on]));

/** Bytes attributed to modules whose path contains `needle`. */
const carries = (b: Built, needle: string): boolean => b.inputs.some((p) => p.includes(needle));

describe("build-time features actually change the bundle", () => {
  let full: Built;
  let minimal: Built;
  let dflt: Built;

  beforeAll(async () => {
    [full, minimal, dflt] = await Promise.all([
      bundle(all(true)), bundle(all(false)), bundle(DEFAULT_PROFILE),
    ]);
  }, 120_000);

  it("drops the offline scripted brain, which was the largest single module", () => {
    // 11 KB, 9% of the old bundle, carried by every television to answer with a
    // keyword matcher when nobody had configured a model.
    expect(carries(full, "llm-connectors/dist/scripted")).toBe(true);
    expect(carries(minimal, "llm-connectors/dist/scripted")).toBe(false);
    expect(carries(dflt, "llm-connectors/dist/scripted")).toBe(false);
  });

  it("drops the diagnostics probes and their markdown", () => {
    expect(carries(full, "core/dist/diagnostics/probe")).toBe(true);
    expect(carries(dflt, "core/dist/diagnostics/probe")).toBe(false);
    expect(carries(dflt, "core/dist/diagnostics/device-report")).toBe(false);
  });

  it("drops the on-screen keyboard without taking the remote mapping with it", () => {
    expect(carries(dflt, "ui/dist/keyboard")).toBe(false);
    // The microphone button needs `remoteIntent` in every build. It used to live
    // inside keyboard.ts, which meant a build that wanted no keyboard still
    // dragged the whole renderer in for thirty lines.
    expect(carries(dflt, "ui/dist/remote-keys")).toBe(true);
  });

  it("drops ModelPilot entirely when the runtime is built without a service", async () => {
    const noService = await bundle({ ...DEFAULT_PROFILE, modelpilot: false });
    for (const module of ["planner", "client", "task-mapper", "action-plan"]) {
      expect(carries(noService, `modelpilot/dist/${module}`)).toBe(false);
    }
  }, 60_000);

  it("keeps what a working television actually needs", () => {
    // The guards must not be able to remove the agent itself. If this ever fails
    // it means a flag has been wrapped around something load-bearing.
    for (const essential of [
      "core/dist/agent/agent", "core/dist/planner/planner", "core/dist/world/model",
      "core/dist/capabilities/tv-capabilities", "core/dist/devices/graph",
      "adapter-aosp/dist/index",
    ]) {
      expect(carries(minimal, essential), `${essential} missing from a minimal build`).toBe(true);
    }
  });

  it("makes the minimal build substantially smaller than the full one", () => {
    // Deliberately a ratio and not a byte count: a byte count would fail on every
    // unrelated edit and get raised until it meant nothing. The claim under test
    // is that the optional half is a large fraction of the whole.
    expect(minimal.bytes).toBeLessThan(full.bytes * 0.7);
    expect(dflt.bytes).toBeLessThan(full.bytes * 0.85);
  });
});
