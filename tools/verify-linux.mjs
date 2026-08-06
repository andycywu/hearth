#!/usr/bin/env node
/**
 * Run the Linux adapter against the machine it is actually on.
 *
 * The unit tests cover the parsers and the contract with a fake `Runner`, which
 * is as far as you can get on a laptop that isn't Linux. This is the other half:
 * no fakes, real `wpctl`/`pactl`/`amixer`, real `.desktop` files, real network
 * interfaces. CI runs it on Ubuntu; run it yourself on a box or a Pi.
 *
 *     node tools/verify-linux.mjs
 *
 * It adapts to what the machine has rather than demanding a particular setup:
 * with no mixer installed, the *correct* behaviour is to report the capability
 * unsupported, so that is what gets asserted. What it will not tolerate is
 * disagreement — claiming audio works and then failing, or claiming it doesn't
 * and then succeeding. That inconsistency is the bug this catches.
 */
import { platform } from "node:process";
import { createLinuxAdapter } from "../packages/adapter-linux/dist/index.js";
import { isTvUnsupported } from "../packages/platform-api/dist/index.js";
import { Agent, createTvTools } from "../packages/core/dist/index.js";
import { createScriptedClient } from "../packages/llm-connectors/dist/index.js";

if (platform !== "linux") {
  console.error(`This checks the Linux adapter on Linux; this is ${platform}. Skipping.`);
  process.exit(0);
}

const problems = [];
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) problems.push(what);
};

const tv = createLinuxAdapter();
await tv.init();

console.log(`\ndevice: ${tv.device.model} · node ${tv.device.osVersion}`);
console.log(`capabilities: ${JSON.stringify(tv.device.capabilities)}\n`);

/**
 * Which backend the adapter picked, from the model string it builds at init.
 * `Linux (pulseaudio)` → `pulseaudio`; plain `Linux` → `none`.
 */
const backend = /\((.+)\)/.exec(tv.device.model)?.[1] ?? "none";

// CI pins this per matrix leg. Without it the script just reports what it found,
// which is what you want when running it on your own box.
//
// It matters because detection is ordered — PipeWire, then PulseAudio, then
// ALSA — and "some backend answered" would pass even if the wrong one did. On a
// box with PipeWire installed, silently driving it through the PulseAudio
// shim is a different code path than the one under test.
const expected = process.env.EXPECT_AUDIO;
if (expected) {
  check(backend === expected, `picked the ${expected} backend (got ${backend})`);
}

// --- audio, whichever way this box answers ------------------------------------
const claimsAudio = tv.device.capabilities.audio === true;
if (claimsAudio) {
  // Both, because both get changed below. Restoring the level but not the mute
  // state would leave a machine unmuted that was muted when we arrived — on
  // someone's actual device that is a rude thing to do.
  const before = await tv.system.getVolume();
  const wasMuted = await tv.system.getMute();
  check(before >= 0 && before <= 100, `getVolume returned ${before}, in 0..100`);

  await tv.system.setVolume(30);
  const after = await tv.system.getVolume();
  // Every backend quantises: ALSA in steps, PipeWire in hundredths. Ask for a
  // number in the right neighbourhood, not the exact one.
  check(Math.abs(after - 30) <= 5, `set 30 → read back ${after} (within 5)`);

  await tv.system.setMute(true);
  check((await tv.system.getMute()) === true, "mute reports true");
  await tv.system.setMute(false);
  check((await tv.system.getMute()) === false, "unmute reports false");

  await tv.system.setVolume(before);
  await tv.system.setMute(wasMuted);
  console.log(`  ..    restored: volume ${before}, muted ${wasMuted}`);
} else {
  // No mixer here. The adapter must say so as *unsupported*, not fail: the
  // difference is what the viewer is told, and whether a model retries.
  let err;
  try {
    await tv.system.getVolume();
  } catch (e) {
    err = e;
  }
  check(err !== undefined, "no mixer installed → getVolume refuses rather than inventing a number");
  check(isTvUnsupported(err), `refusal is typed unsupported (got ${err?.name}: ${err?.message})`);
}

// --- the things a Linux box genuinely cannot do -------------------------------
for (const [what, call] of [
  ["setInputSource", () => tv.system.setInputSource("hdmi1")],
  ["sendKey", () => tv.navigation.sendKey("ok")],
  ["powerStandby", () => tv.system.powerStandby()],
]) {
  let err;
  try { await call(); } catch (e) { err = e; }
  check(isTvUnsupported(err), `${what} reports unsupported, not a retryable failure`);
}
check((await tv.navigation.isAvailable()) === false, "navigation.isAvailable() agrees with sendKey");

// --- apps, network, storage ---------------------------------------------------
const apps = await tv.apps.listInstalledApps();
console.log(`  ..    ${apps.length} desktop entries found`);
check(Array.isArray(apps), "listInstalledApps returns an array");
check(apps.every((a) => a.id && a.name), "every entry has an id and a name");
if (apps.length) {
  const [first] = apps;
  const found = await tv.apps.findAppsByName(first.name.slice(0, 4));
  check(found.some((a) => a.id === first.id), `findAppsByName located "${first.name}"`);
}

const conn = await tv.network.connectionType();
check(["wifi", "ethernet", "none"].includes(conn), `connectionType is a known value (${conn})`);
check(typeof (await tv.network.isOnline()) === "boolean", "isOnline returns a boolean");

await tv.storage.set("verify", "1");
check((await tv.storage.get("verify")) === "1", "storage round-trips");
await tv.storage.delete("verify");
check((await tv.storage.get("verify")) === null, "storage delete removes the key");

// --- the whole agent, on this machine -----------------------------------------
// The point of the exercise: the same loop the televisions run, driving this box.
const agent = new Agent({ platform: tv, llm: createScriptedClient(), confirm: () => true });
const tools = createTvTools(tv);
check(tools.length > 0, `${tools.length} tools registered`);
check(!tools.some((t) => /linux|android|tizen/i.test(t.spec.name)), "no tool name mentions an OS");

const reply = await agent.run("what's the volume?");
console.log(`  ..    agent said: ${reply}`);
check(typeof reply === "string" && reply.length > 0, "the agent answered");

console.log(problems.length
  ? `\n${problems.length} problem(s):\n  - ${problems.join("\n  - ")}\n`
  : "\nAll checks passed on this machine.\n");
process.exit(problems.length ? 1 : 0);
