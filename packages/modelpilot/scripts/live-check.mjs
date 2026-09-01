#!/usr/bin/env node
/**
 * The first run against the real ModelPilot.
 *
 * Same runtime, same planner, same executor as a television — but a *mock* TV
 * (the web adapter), so what this proves is the ModelPilot half: that the call
 * goes out, that a real model returns something the strict parser accepts, and
 * that the local verdict reaches /v1/feedback. It proves nothing about
 * hardware; that still needs a device.
 *
 * The key is read from the environment and never printed. Run with:
 *   node --env-file=.env.local <this file>
 */
import {
  Agent, DeviceGraph, WorldModel, CapabilityGraph, capabilitiesForPlatform, W,
} from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import {
  createModelPilotClient, createModelPilotPlanner, resolveModelPilotConfig,
} from "../dist/index.js";

const config = resolveModelPilotConfig({ env: process.env });
if (!config.apiKey) {
  console.error("no MODELPILOT_API_KEY in the environment — nothing will be called");
  process.exit(1);
}
console.log(`endpoint : ${config.baseUrl}`);
console.log(`mode     : ${config.mode} (${config.source})`);
console.log(`budget   : $${config.maxTaskBudget} · timeout ${config.timeoutMs}ms`);
console.log("");

const client = createModelPilotClient({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  timeoutMs: config.timeoutMs,
  identity: { installId: "hth_livecheck", runtimeVersion: "0.2.0", mode: config.mode },
});

// What the service will route between. A 401 here and nothing else matters.
try {
  const models = await client.listModels();
  console.log("catalogue:", (models?.data ?? []).map((m) => m.id).join(", ") || "(empty)");
} catch (err) {
  console.error(`catalogue: ${err.kind ?? "error"} — ${err.message}`);
  process.exit(1);
}
console.log("");

/**
 * Two goals, because they exercise different halves.
 *
 * `input_switched` is measurable, so the deterministic planner produces a plan
 * too and shadow can actually compare the two. `freeform` is the long tail —
 * nothing local can close it, which is the case ModelPilot exists for.
 */
const goals = [
  { id: "input_switched", intent: "put the PlayStation on", desiredState: [{ path: W.tvInput, equals: "hdmi2" }] },
  { id: "freeform", intent: "put the news on", desiredState: [] },
];

for (const goal of goals) {
  const platform = createWebAdapter();
  await platform.init();
  const world = new WorldModel();
  const devices = new DeviceGraph();
  devices.observe({
    id: "ps5", name: "console", type: "game_console",
    connection: { kind: "hdmi", port: "hdmi2" }, source: "manual", confidence: 1,
  });
  const graph = new CapabilityGraph();
  graph.registerAll(capabilitiesForPlatform(platform));

  const telemetry = [];
  const planner = createModelPilotPlanner({
    client, mode: config.mode, graph, world, devices,
    maxTaskBudget: config.maxTaskBudget,
    telemetry: (r) => telemetry.push(r),
  });
  const llm = { id: "silent", complete: async () => ({ wantsToolCalls: false, message: { role: "assistant", content: "ok" } }) };
  const agent = new Agent({ platform, llm, devices, world, planner, llmPlanning: true, confirm: () => true });

  const reported = [];
  agent.events.on("plan:end", ({ outcome }) => reported.push(planner.report(outcome)));

  console.log(`── goal: ${goal.id} — "${goal.intent}"`);
  const outcome = await agent.pursue(goal);
  await Promise.all(reported);

  console.log("  plan     :", outcome.plan.steps.map((s) => `${s.action.capabilityId}(${JSON.stringify(s.action.args)})`).join(", ") || "(none)");
  console.log("  outcomes :", outcome.outcomes.map((o) => `${o.step.action.capabilityId}:${o.status}`).join(", ") || "(none)");
  console.log("  summary  :", agent.describe(outcome));
  for (const s of planner.shadow) {
    console.log("  suggested:", s.remoteSteps.join(", ") || "(none)", `· local: ${s.localSteps.join(", ") || "(none)"} · ${s.agreement}`);
  }
  for (const r of telemetry) console.log("  telemetry:", JSON.stringify(r));
  console.log("");
}
