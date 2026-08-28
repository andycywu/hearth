#!/usr/bin/env node
/**
 * Run the HDMI-CEC transport against a real bus, and print a transcript.
 *
 *     node tools/verify-cec.mjs                  # look, change nothing
 *     node tools/verify-cec.mjs --writes         # also wake and standby a device
 *     node tools/verify-cec.mjs --device /dev/cec1 --to 4
 *
 * Everything in `packages/adapter-cec` is verified against a mock bus, and
 * everything in the Linux transport is verified against fixtures written from
 * `cec-ctl`'s documentation. Neither of those is a television. **This script is
 * the only thing in the repo that can tell us whether any of it is true**, and
 * it is written so that the answer is useful whether it passes or fails:
 *
 *  - It prints the raw `cec-ctl` output next to what the parser made of it, so a
 *    mismatch is one glance rather than one debugging session.
 *  - It ends with a fixture block ready to paste into `cec.test.ts`, because the
 *    most valuable thing a person with a Pi can send back is what their bus
 *    actually said.
 *
 * Read-only by default. `--writes` wakes a device and puts it back, which is
 * visible in the room — the same rule `?diag&writes` follows on a television.
 */
import { argv } from "node:process";
import { createLinuxCecTransport, parseTopology, parsePowerStatus } from "../packages/adapter-linux/dist/index.js";
import { systemRunner } from "../packages/adapter-linux/dist/index.js";
import { createCecSource, deviceTypeFor, connectionFor, parentPhysical } from "../packages/adapter-cec/dist/index.js";
import { DeviceGraph, deviceTreeText, runDiscovery } from "../packages/core/dist/index.js";

const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const device = flag("device", "/dev/cec0");
const writes = argv.includes("--writes");
const only = flag("to", undefined);

const problems = [];
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) problems.push(what);
};

// The raw output is captured alongside every call, because the parser being
// wrong and the bus being empty look identical in a parsed result.
const transcript = [];
const run = (() => {
  const inner = systemRunner(20_000);
  return async (cmd, args) => {
    const result = await inner(cmd, args);
    transcript.push({ cmd: [cmd, ...args].join(" "), ...result });
    return result;
  };
})();

const cec = createLinuxCecTransport({ device, run });

console.log(`\nHDMI-CEC on ${device}\n${"─".repeat(40)}`);

const available = await cec.available();
// Not a `check`: no CEC adapter is a fact about the machine, not a defect. The
// runtime is built to handle exactly this, so failing here would be asserting
// that everyone running the script owns a Pi.
console.log(`  ${available ? " ok " : "note"}  ${available ? `an adapter answered on ${device}` : `no adapter on ${device}`}`);
if (!available) {
  console.log(`
Nothing to check. That is a normal answer, and worth knowing which kind it is:

  - \`cec-ctl: command not found\`  → apt install v4l-utils
  - \`No such file or directory\`   → no CEC adapter, or the driver is not loaded
                                     (on a Pi: dtoverlay=vc4-kms-v3d, and CEC on
                                     the HDMI port you are actually using)
  - \`Permission denied\`           → add yourself to the \`video\` group

The runtime treats all three the same way — the capability is withdrawn and the
model is never offered it — which is the behaviour worth confirming here.`);
    process.exit(0);
}

// --- the scan ----------------------------------------------------------------
let devices = [];
try {
  devices = await cec.scan();
  check(true, `scanned the bus (${devices.length} device${devices.length === 1 ? "" : "s"})`);
} catch (err) {
  check(false, `scan failed: ${err?.message ?? err}`);
}

for (const d of devices) {
  const type = deviceTypeFor(d);
  const where = connectionFor(d);
  const parent = parentPhysical(d.physical);
  console.log(
    `        ${String(d.logical).padStart(2)} · ${(d.physical ?? "?").padEnd(8)} · ` +
    `${(d.osdName ?? "(no name)").padEnd(20)} → ${type}, ${where.kind === "hdmi" ? where.port : where.kind}` +
    `${parent ? `, behind ${parent}` : ""}`,
  );
}

// Every device that answered should have told us where it is; a device with no
// physical address cannot be woken, and that is worth seeing here rather than
// discovering when a plan reports `unsupported`.
const addressless = devices.filter((d) => !d.physical);
check(addressless.length === 0, `every device reported a physical address${
  addressless.length ? ` (${addressless.length} did not)` : ""}`);

// --- the room, as the Device Graph would hold it ------------------------------
const graph = new DeviceGraph();
const result = await runDiscovery(graph, [createCecSource(cec)]);
check(result.failed.length === 0, "the discovery source ran without failing");
console.log(`\n${deviceTreeText(graph)}\n`);

// --- power status, the read that makes verification possible ------------------
const targets = only
  ? devices.filter((d) => String(d.logical) === String(only))
  : devices.filter((d) => d.logical !== 0);

if (!targets.length) console.log("  --   no device to ask about power (only the TV answered)");

const answered = [];
for (const target of targets) {
  let state = "unknown";
  try {
    state = await cec.powerStatus(target.logical);
  } catch (err) {
    check(false, `power status for ${target.logical}: ${err?.message ?? err}`);
    continue;
  }
  const name = target.osdName ?? `device ${target.logical}`;
  console.log(`  ${state === "unknown" ? "note" : " ok "}  ${name}: ${state}`);
  if (state !== "unknown") answered.push(target);
}

// This is not a failure. A device that never answers <Give Device Power Status>
// is working correctly and cannot be verified, and the runtime is built to say
// `unverified` rather than guess. Knowing *which* devices those are is the point
// of running this at all.
console.log(
  `\n${answered.length}/${targets.length} device(s) answer <Give Device Power Status>. ` +
  `Only those can ever report \`verified\` for a power change; the rest are \`unverified\` by nature.`,
);

// --- writes, only when asked --------------------------------------------------
if (writes && answered.length) {
  const target = answered[0];
  const before = await cec.powerStatus(target.logical);
  console.log(`\nwaking ${target.osdName ?? target.logical} (was ${before}) …`);
  await cec.wake(target);
  // CEC devices take their time; the capability's own verification allows 8 s.
  await new Promise((r) => setTimeout(r, 8000));
  const after = await cec.powerStatus(target.logical);
  console.log(`  → ${after}`);

  // The three outcomes the runtime distinguishes, observed on real hardware.
  if (after === "on") check(true, "the device woke and said so — this is `verified`");
  else if (after === "unknown") check(true, "the device stopped answering — this is `unverified`");
  else check(true, `the device accepted <Set Stream Path> and stayed ${after} — this is \`failed\`, and it is the case this project exists for`);

  if (before === "standby" && after === "on") {
    console.log("putting it back …");
    await cec.standby(target.logical);
  }
} else if (writes) {
  console.log("\n--writes: nothing to write to (no device answers power status).");
}

// --- the transcript, for the fixtures -----------------------------------------
console.log(`\n${"─".repeat(40)}\nRaw transcript — paste this into packages/adapter-linux/src/cec.test.ts,\nwhich currently uses fixtures written from documentation rather than hardware:\n`);
for (const entry of transcript) {
  console.log(`$ ${entry.cmd}   (exit ${entry.code})`);
  const body = (entry.stdout || entry.stderr || "").trimEnd();
  console.log(body ? `${body}\n` : "(no output)\n");
}

// Show where the parsers and the raw output disagree, if anywhere.
const topologyRun = transcript.find((t) => t.cmd.includes("--show-topology"));
if (topologyRun) {
  const reparsed = parseTopology(topologyRun.stdout);
  check(
    reparsed.length === devices.length,
    `the topology parser reads the same device count from the raw output (${reparsed.length} vs ${devices.length})`,
  );
}
const powerRun = transcript.find((t) => t.cmd.includes("--give-device-power-status"));
if (powerRun) {
  console.log(`parsePowerStatus of the first reply: ${parsePowerStatus(powerRun.stdout)}`);
}

console.log(`\n${problems.length ? `${problems.length} problem(s):\n  - ${problems.join("\n  - ")}` : "No problems."}`);
console.log(`
Whatever this printed, it is worth sending back — a bus that disagrees with the
parser is the most useful bug report this package can get, and a bus that agrees
is the first evidence any of it works.
`);
process.exit(problems.length ? 1 : 0);
