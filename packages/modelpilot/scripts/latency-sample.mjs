/**
 * How long does a real plan actually take? Sampled rather than guessed.
 *
 * The default timeout was 5000ms because that is a round number, and the first
 * live run showed why a round number is not a measurement.
 */
import {
  DeviceGraph, WorldModel, CapabilityGraph, capabilitiesForPlatform, W,
} from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { buildCompletionRequest, createModelPilotClient, resolveModelPilotConfig, parseActionPlan } from "../dist/index.js";

const config = resolveModelPilotConfig({ env: process.env });
const client = createModelPilotClient({
  baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 60000,
});

const platform = createWebAdapter();
await platform.init();
const devices = new DeviceGraph();
devices.observe({
  id: "ps5", name: "console", type: "game_console",
  connection: { kind: "hdmi", port: "hdmi2" }, source: "manual", confidence: 1,
});
const capabilities = new CapabilityGraph();
capabilities.registerAll(capabilitiesForPlatform(platform));

const goals = [
  { id: "input_switched", intent: "put the PlayStation on", desiredState: [{ path: W.tvInput, equals: "hdmi2" }] },
  { id: "freeform", intent: "put the news on", desiredState: [] },
  { id: "freeform", intent: "make it quieter", desiredState: [] },
  { id: "freeform", intent: "我要打 PS5", desiredState: [] },
];

const rounds = Number(process.argv[2] ?? 2);
const samples = [];
for (let round = 0; round < rounds; round++) {
  for (const goal of goals) {
    const request = buildCompletionRequest({ goal, world: new WorldModel(), devices, capabilities });
    try {
      const answer = await client.complete(request);
      const parsed = parseActionPlan(answer.output);
      samples.push({ ms: answer.latencyMs, cost: answer.actualCost, ok: parsed.ok, model: answer.selectedModel });
      console.log(
        `${String(answer.latencyMs).padStart(6)}ms  ${parsed.ok ? "parsed " : "REJECT "}`
        + `${answer.selectedModel}  $${answer.actualCost}  ${goal.intent}`
        + (parsed.ok ? ` -> ${parsed.plan.action}` : ` -> ${parsed.errors.join("; ")}`),
      );
    } catch (err) {
      samples.push({ ms: -1, ok: false });
      console.log(`  ERROR  ${err.kind ?? "?"}: ${err.message}`);
    }
  }
}

const ok = samples.filter((s) => s.ms > 0).map((s) => s.ms).sort((a, b) => a - b);
const at = (q) => ok[Math.min(ok.length - 1, Math.floor(q * ok.length))];
console.log("");
console.log(`n=${ok.length}  min=${ok[0]}  p50=${at(0.5)}  p90=${at(0.9)}  max=${ok[ok.length - 1]}`);
console.log(`parsed ${samples.filter((s) => s.ok).length}/${samples.length}`);
console.log(`cost   $${samples.reduce((t, s) => t + (s.cost ?? 0), 0).toFixed(6)} total`);
