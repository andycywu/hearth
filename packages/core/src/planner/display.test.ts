import { describe, it, expect } from "vitest";
import { createWebAdapter } from "@hearthkit/adapter-web";
import type { DisplayControl, PlatformProvider, ScreenLayout } from "@hearthkit/platform-api";
import { CapabilityGraph } from "../capabilities/graph.js";
import { createDisplayCapabilities } from "../capabilities/tv-capabilities.js";
import { PolicyEngine } from "../policy/policy.js";
import { ToolRegistry } from "../tools/registry.js";
import { createTvTools } from "../tools/tv-tools.js";
import { WorldModel } from "../world/model.js";
import { W } from "../world/state.js";
import { GoalPlanner } from "./planner.js";
import { PlanExecutor } from "./executor.js";

/**
 * Where the picture is, end to end: goal -> plan -> `set_screen_layout` -> read-back -> verdict.
 *
 * The case worth the file is the last one. On Tizen nothing reports that the video window is hidden, so the adapter answers *nothing* once it
 * has hidden it, and a `hearth` layout must end `unverified` — not `verified` on the strength of our own optimistic write.
 */

/** A web adapter with its display replaced by one that behaves like the television's. */
function platformWith(display: DisplayControl): PlatformProvider {
  return { ...createWebAdapter(), display };
}

function harness(platform: PlatformProvider) {
  const world = new WorldModel();
  const graph = new CapabilityGraph();
  const tools = new ToolRegistry();
  for (const tool of createTvTools(platform)) tools.register(tool);
  graph.registerAll(createDisplayCapabilities("adapter:test"));
  const planner = new GoalPlanner({ graph, world });
  const executor = new PlanExecutor({ graph, world, tools, policy: new PolicyEngine(), confirm: async () => true });
  return { world, planner, executor, tools };
}

const outcomeFor = async (platform: PlatformProvider, layout: ScreenLayout) => {
  const { planner, executor } = harness(platform);
  const plan = await planner.plan({ id: "layout", desiredState: [{ path: W.tvLayout, equals: layout }] });
  return { plan, outcome: await executor.run(plan) };
};

describe("screen layout", () => {
  it("is offered only on a device with a display slot", () => {
    const { display: _display, ...without } = createWebAdapter();
    const bare: PlatformProvider = { ...without, has: () => false };
    expect(createTvTools(bare).map((t) => t.spec.name)).not.toContain("set_screen_layout");
    expect(createTvTools(createWebAdapter()).map((t) => t.spec.name)).toEqual(expect.arrayContaining(["get_screen_layout", "set_screen_layout"]));
  });

  it("plans, sets and verifies a layout the television reads back", async () => {
    let layout: ScreenLayout | undefined = "fullscreen";
    const display: DisplayControl = { getLayout: async () => layout, setLayout: async (l) => { layout = l; } };
    const { plan, outcome } = await outcomeFor(platformWith(display), "panel");
    expect(plan.steps.map((s) => s.action.capabilityId)).toEqual(["tv.display.set_layout"]);
    expect(plan.steps[0]?.action.args).toEqual({ layout: "panel" });
    expect(outcome.outcomes[0]?.status).toBe("verified");
    expect(layout).toBe("panel");
  });

  it("says failed when the television accepts a layout and reports another", async () => {
    const display: DisplayControl = { getLayout: async () => "fullscreen", setLayout: async () => {} };
    expect((await outcomeFor(platformWith(display), "panel")).outcome.outcomes[0]?.status).toBe("failed");
  });

  it("says unverified — not verified — when the layout cannot be read back, as after hide on Tizen", async () => {
    const display: DisplayControl = { getLayout: async () => undefined, setLayout: async () => {} };
    expect((await outcomeFor(platformWith(display), "hearth")).outcome.outcomes[0]?.status).toBe("unverified");
  });
});
