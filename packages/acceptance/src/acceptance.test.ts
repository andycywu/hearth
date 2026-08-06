import { describe, it, expect } from "vitest";
import { Agent, createTvTools } from "@tv-ai-agent/core";
import { createScriptedClient } from "@tv-ai-agent/llm-connectors";
import { targets } from "./mocks.js";

/**
 * The Phase 2 acceptance demo, run headless on every adapter. The SAME command
 * script must produce the SAME tool-call sequence and the SAME final device
 * state on web / Tizen / AOSP / webOS — this is the cross-target guarantee
 * without needing real hardware.
 */
const SCRIPT = [
  "set volume to 30",
  "make it louder",
  "mute",
  "open Netflix",
  "what's the volume?",
];

const EXPECTED_TOOLS = [
  "set_volume",                    // set volume to 30
  "get_volume", "set_volume",      // louder: read then +10
  "set_mute",                      // mute
  "search_app_by_name", "launch_app", // open Netflix
  "get_volume",                    // what's the volume
];

async function runScript(target: ReturnType<typeof targets>[number]) {
  const platform = target.make();
  try {
    const agent = new Agent({ platform, llm: createScriptedClient(), confirm: () => true });
    const tools: string[] = [];
    agent.events.on("tool:call", (e) => tools.push(e.name));
    for (const cmd of SCRIPT) await agent.run(cmd);
    return {
      tools,
      volume: await platform.system.getVolume(),
      muted: await platform.system.getMute(),
    };
  } finally {
    target.teardown();
  }
}

describe("cross-target acceptance", () => {
  for (const target of targets()) {
    it(`behaves identically on ${target.name}`, async () => {
      const r = await runScript(target);
      expect(r.tools).toEqual(EXPECTED_TOOLS);
      expect(r.volume).toBe(40); // 30 then +10
      expect(r.muted).toBe(true);
    });
  }

  /**
   * The architectural guarantee, asserted directly rather than inferred from
   * behaviour: the model must never see `android_launch_app` next to
   * `webos_launch_app`. Platform differences live below this line, in the
   * adapter.
   *
   * The vocabulary is allowed to vary in exactly one way — an optional
   * capability the device doesn't have. That is deliberate and is the opposite
   * of an OS-specific schema: a TV with no media transport shouldn't be offered
   * `media_play` at all, whatever OS it runs. So the *core* vocabulary must be
   * identical everywhere, and every difference must be a capability-gated tool.
   */
  const CAPABILITY_GATED = /^media_/;

  it("exposes one tool vocabulary, not one per OS", () => {
    const byTarget = targets().map((target) => {
      const platform = target.make();
      try {
        return { name: target.name, tools: createTvTools(platform).map((t) => t.spec.name) };
      } finally {
        target.teardown();
      }
    });

    for (const { name, tools } of byTarget) {
      expect(tools.join(","), `${name} must not name an OS in a tool`)
        .not.toMatch(/android|tizen|webos|aosp/i);
    }

    const core = byTarget.map(({ tools }) => tools.filter((t) => !CAPABILITY_GATED.test(t)).sort().join(","));
    expect(new Set(core).size, "the core vocabulary must be identical on every OS").toBe(1);

    // And whatever does differ is a capability, not a platform quirk.
    const all = new Set(byTarget.flatMap(({ tools }) => tools));
    for (const tool of all) {
      const everywhere = byTarget.every(({ tools }) => tools.includes(tool));
      if (!everywhere) expect(tool, `${tool} varies between targets`).toMatch(CAPABILITY_GATED);
    }
  });

  it("all four targets yield the same tool sequence", async () => {
    const results = [];
    for (const target of targets()) results.push((await runScript(target)).tools.join(","));
    const unique = new Set(results);
    expect(unique.size).toBe(1); // identical across web/tizen/aosp/webos
  });
});
