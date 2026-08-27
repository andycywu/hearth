#!/usr/bin/env node
/**
 * One manual end-to-end check: real HTTP, real client, real planner, real
 * executor, real local verification. Against the mock server by default, and
 * against production if you point it there and accept the cost.
 *
 *   node tools/mock-modelpilot-server.mjs --port 8090 --answer set_input:hdmi3 &
 *   MODELPILOT_BASE_URL=http://127.0.0.1:8090 MODELPILOT_API_KEY=test  *   MODELPILOT_MODE=enforce node packages/modelpilot/scripts/check.mjs
 *
 * Try `--answer unverified`, `--answer invalid`, `--answer power` and
 * `--answer slow` on the server: the television must be left alone by all four,
 * and the printed summary must say which one happened.
 */
import { Agent, DeviceGraph, WorldModel, CapabilityGraph, capabilitiesForPlatform } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createModelPilotClient, createModelPilotPlanner } from "../dist/index.js";

const platform = createWebAdapter();
await platform.init();
const world = new WorldModel();
const devices = new DeviceGraph();
const graph = new CapabilityGraph();
graph.registerAll(capabilitiesForPlatform(platform));

const client = createModelPilotClient({
  baseUrl: process.env.MODELPILOT_BASE_URL,
  apiKey: process.env.MODELPILOT_API_KEY,
  timeoutMs: 3000,
});
const telemetry = [];
const planner = createModelPilotPlanner({
  client, mode: process.env.MODELPILOT_MODE, graph, world, devices,
  telemetry: (r) => telemetry.push(r),
});
const llm = { id: "silent", complete: async () => ({ wantsToolCalls: false, message: { role: "assistant", content: "ok" } }) };
const agent = new Agent({ platform, llm, devices, world, planner, llmPlanning: true, confirm: () => true });

const outcome = await agent.pursue({ id: "freeform", intent: "put the news on", desiredState: [] });
console.log("plan     :", outcome.plan.steps.map((s) => `${s.action.capabilityId}(${JSON.stringify(s.action.args)})`).join(", ") || "(none)");
console.log("outcomes :", outcome.outcomes.map((o) => `${o.step.action.capabilityId}:${o.status}`).join(", ") || "(none)");
console.log("achieved :", outcome.achieved);
console.log("summary  :", agent.describe(outcome));
console.log("tv input :", await platform.system.getInputSource());
console.log("telemetry:", JSON.stringify(telemetry));
