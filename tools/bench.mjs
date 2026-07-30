#!/usr/bin/env node
/**
 * Agent-loop latency benchmark.
 *
 *   node tools/bench.mjs [--iterations 50] [--json]
 *
 * Runs the acceptance command script through the real agent loop (web adapter +
 * offline scripted brain) and reports per-turn latency. The scripted brain
 * answers instantly, so what's measured is the *harness overhead* — tool
 * validation, the tool-call round trips, context assembly, event dispatch — with
 * no model or network noise. That's the number that has to stay small on a TV
 * SoC, and a regression here is a regression in our own code.
 *
 * Requires `pnpm build` first (it imports the built dist/).
 */
import { performance } from "node:perf_hooks";

const { Agent } = await import("../packages/core/dist/index.js");
const { createWebAdapter } = await import("../packages/adapter-web/dist/index.js");
const { createScriptedClient } = await import("../packages/llm-connectors/dist/index.js");

// Same script as packages/acceptance, so the benchmark and the correctness test
// exercise the same path.
const SCRIPT = [
  "set volume to 30",
  "make it louder",
  "mute",
  "open Netflix",
  "what's the volume?",
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const iterations = flag("--iterations", 50);
const asJson = args.includes("--json");

// Silence the mock adapter's console.info so it can't skew the timings.
const info = console.info;
console.info = () => {};

const perTurn = [];
const perScript = [];

// One untimed pass so JIT warm-up doesn't land in the p95.
await runScript(new Agent({ platform: createWebAdapter(), llm: createScriptedClient(), confirm: () => true }), []);

for (let i = 0; i < iterations; i++) {
  const agent = new Agent({
    platform: createWebAdapter(),
    llm: createScriptedClient(),
    confirm: () => true,
  });
  const start = performance.now();
  await runScript(agent, perTurn);
  perScript.push(performance.now() - start);
}

console.info = info;

async function runScript(agent, sink) {
  for (const cmd of SCRIPT) {
    const t0 = performance.now();
    await agent.run(cmd);
    sink.push(performance.now() - t0);
  }
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    min: s[0],
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
};

const turn = stats(perTurn);
const script = stats(perScript);

if (asJson) {
  console.log(JSON.stringify({ iterations, turn, script }, null, 2));
} else {
  const ms = (n) => `${n.toFixed(2)}ms`;
  console.log(`\nAgent loop benchmark — ${iterations} iterations × ${SCRIPT.length} turns`);
  console.log("(web adapter + offline scripted brain: harness overhead only, no model)\n");
  console.log(`  per turn    n=${turn.n}  p50 ${ms(turn.p50)}   p95 ${ms(turn.p95)}   min ${ms(turn.min)}   max ${ms(turn.max)}   mean ${ms(turn.mean)}`);
  console.log(`  per script  n=${script.n}  p50 ${ms(script.p50)}   p95 ${ms(script.p95)}   mean ${ms(script.mean)}`);
  console.log(`\n  ${SCRIPT.length} turns/script · ${(script.mean / SCRIPT.length).toFixed(2)}ms avg/turn\n`);
}
