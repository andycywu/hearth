import { describe, it, expect } from "vitest";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import { createTvTools, capabilitiesForPlatform, tvHandlers } from "../tools/tv-tools.js";
import { toolsFromCapabilities, toolSpecFor } from "./to-tools.js";
import type { Capability } from "./types.js";

const capability = (over: Partial<Capability> = {}): Capability => ({
  id: "tv.test.thing",
  name: "Thing",
  description: "Do the thing, for the model to choose on.",
  device: "tv",
  domain: "meta",
  parameters: { how: { type: "string", description: "how", required: true } },
  tool: "do_thing",
  riskLevel: "low",
  provider: "adapter:web",
  confidence: 1,
  status: "available",
  ...over,
});

describe("capabilities -> tools", () => {
  it("takes the model-facing spec from the capability", () => {
    const spec = toolSpecFor(capability());
    expect(spec).toEqual({
      name: "do_thing",
      description: "Do the thing, for the model to choose on.",
      parameters: { how: { type: "string", description: "how", required: true } },
    });
  });

  it("derives confirmation from the risk level rather than a separate flag", () => {
    expect(toolSpecFor(capability({ riskLevel: "low" })).confirm).toBeUndefined();
    for (const riskLevel of ["medium", "high", "critical"] as const) {
      expect(toolSpecFor(capability({ riskLevel })).confirm).toBe(true);
    }
  });

  it("does not project a capability nothing implements", () => {
    const unimplemented: Capability[] = [];
    const tools = toolsFromCapabilities([capability()], {}, {
      onUnimplemented: (c) => unimplemented.push(c),
    });
    // A declared-but-unreachable capability stays in the graph for the planner
    // to reason about, and never becomes a tool the model can call.
    expect(tools).toEqual([]);
    expect(unimplemented.map((c) => c.id)).toEqual(["tv.test.thing"]);
  });

  it("wraps results and failures in the shared envelope", async () => {
    const [ok] = toolsFromCapabilities([capability()], { "tv.test.thing": async () => ({ did: true }) });
    expect(await ok!.execute({ how: "now" })).toEqual({ ok: true, data: { did: true } });

    const [bad] = toolsFromCapabilities([capability()], {
      "tv.test.thing": async () => { throw new Error("Not supported: no such API"); },
    });
    expect(await bad!.execute({ how: "now" })).toEqual({
      ok: false, error: "unsupported", message: "no such API",
    });
  });

  it("adds a tool when a capability is added, with no second list to edit", () => {
    const platform = createWebAdapter();
    const catalogue = capabilitiesForPlatform(platform);
    const extra = capability({ id: "tv.display.enable_game_mode", tool: "enable_game_mode" });

    const before = createTvTools(platform).map((t) => t.spec.name);
    const after = toolsFromCapabilities(
      [...catalogue, extra],
      { ...tvHandlers(platform), "tv.display.enable_game_mode": async () => undefined },
    ).map((t) => t.spec.name);

    expect(after).toEqual([...before, "enable_game_mode"]);
  });

  it("offers no tool that is not a capability", () => {
    const platform = createWebAdapter();
    const declared = new Set(capabilitiesForPlatform(platform).map((c) => c.tool));
    for (const tool of createTvTools(platform)) {
      expect(declared, `${tool.spec.name} has no capability`).toContain(tool.spec.name);
    }
  });
});
