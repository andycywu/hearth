#!/usr/bin/env node
/**
 * Turns an attached Tizen television into a pasteable Hearth Report section.
 *
 *   node tools/device-report-tizen.mjs [--serial <sdb-serial>] [--out docs/platform/reports/my-tv.md]
 *
 * The Android twin of this (`device-report.mjs`) has existed since the first
 * emulator bring-up; Tizen had no equivalent, so a report from a Samsung TV
 * meant opening the Web Inspector and copying a table out of a console by hand.
 * That is the difference between a report this project gets and one it does not:
 * [the Hearth Report](../docs/platform/capability-matrix.md) is the main output,
 * and every manual step between a stranger's television and that table is a
 * place the table does not get filled in.
 *
 * The formatting happens *on the device*, by the same `exposeDeviceReport` code
 * every host ships. This script only carries the answer back, so a report
 * produced here is byte-identical to one produced by hand in the inspector, and
 * identical in shape to Android's.
 *
 * Prerequisites:
 *
 *   sdb connect <tv-ip>:26101           # or plug in USB
 *   node tools/package-tizen.mjs --profile <profile> --with diag --with offline \
 *        --flags plan --flags confirm=auto --flags room=demo
 *   tz install -p apps/tizen-app/Debug/tizen-app.wgt
 *
 * The build flags go on the **packager**, not on a separate `bundle.mjs` run:
 * packaging re-bundles, so `node tools/bundle.mjs tizen --with diag` followed by
 * a plain `package-tizen.mjs` silently overwrites what you just built with the
 * default profile. The report then fails saying the diagnostics are missing,
 * which is true and is not the reason.
 *
 * `--with offline` because the host refuses to boot with no model configured,
 * and a capability report does not need a real one. Without it — and without a
 * `--flags llm=…` — the page dies at boot with "No model endpoint configured"
 * and there is nothing exposed to collect.
 *
 * Note the flags go in at *package* time. Tizen's web runtime drops the query
 * string from config.xml's `<content src>`, so unlike Android there is no
 * launch-time `-e start` to pass them — this script reads back what the
 * installed build actually carries and names the repackage command when what it
 * needs is missing, rather than producing a report that quietly measured
 * something else.
 *
 * `confirm=auto` because gated tools would otherwise wait on a dialog nobody is
 * here to press. `room=demo` seeds a console on HDMI2 so the multi-device
 * scenario has something to plan for on a television with nothing plugged in —
 * the report says so where it is used.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  findSdb, sdbFor, requireDevice, launchWithInspector, forwardInspector, unforward,
  independentVolume, Cdp, findPageTarget, waitFor, readAudioApi, readFlags, NO_AUDIO_NOTE,
} from "./tizen-device.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const serial = opt("--serial", null);
const appId = opt("--app-id", "tvaiagent0.TvAiAgent");
const out = opt("--out", null);
const intents = opt("--intents", null);
const noWrites = has("--no-writes");
const asJson = has("--json");

const log = (...a) => { if (!asJson) console.error(...a); };

let cdp;
let port;
let sdb;
try {
  sdb = sdbFor(findSdb(), serial);
  log(`[report] devices: ${requireDevice(sdb).join(" | ")}`);

  const launched = launchWithInspector(sdb, appId);
  port = launched.port;
  log(`[report] ${appId} started via \`${launched.via}\`, inspector on device port ${port}`);
  forwardInspector(sdb, port);

  const target = await findPageTarget(port);
  log(`[report] page: ${target.url}`);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  // Wait for the host to finish booting and expose the helper, rather than
  // guessing at a sleep: a slow television would otherwise fail here for a
  // reason that says nothing about the television.
  if (!(await waitFor(cdp, "typeof window.__hearthReport === 'function'"))) {
    throw new Error(
      "the page never exposed __hearthReport.\n" +
      "  The default build does not carry the diagnostics — they are 7.9 KB that a\n" +
      "  working television never runs. Rebuild the bundle with them, repackage and\n" +
      "  reinstall:\n" +
      "      node tools/bundle.mjs tizen --with diag      (or --full)\n" +
      "      node tools/package-tizen.mjs --flags plan --flags confirm=auto\n" +
      "      tz install -p apps/tizen-app/Debug/tizen-app.wgt\n" +
      "  See packages/core/src/features.ts. If the app did not boot at all,\n" +
      "  window.__tvAgent will be missing too — read the console on this same port.",
    );
  }

  // The two things a Tizen report must state about itself before anything it
  // measured can be read correctly.
  const audio = await readAudioApi(cdp);
  log(`[report] audio API: ${audio.name}`);

  const flags = await readFlags(cdp);
  log(`[report] launch flags: ${flags || "(none)"}`);

  const independent = independentVolume(sdb);
  if (independent) log(`[report] independent readback: ${independent.key} = ${independent.value}`);

  const notes = [
    `collected by tools/device-report-tizen.mjs over the Web Inspector (launched with \`${launched.via}\`)`,
    `launch flags baked into this package: ${flags || "(none)"}`,
    `audio control API present on this build: ${audio.name}`,
  ];
  if (audio.none) notes.push(NO_AUDIO_NOTE);
  if (!/confirm=auto/.test(flags)) {
    notes.push(
      "confirm=auto is NOT in the launch flags — confirm-gated tools stall on a dialog " +
      "nobody is here to press, so anything gated is unanswered here rather than unsupported. " +
      "Repackage with `node tools/package-tizen.mjs --flags confirm=auto ...`",
    );
  }
  if (/room=demo/.test(flags)) {
    notes.push("the PS5/STB in the room section are seeded by `room=demo`, not real hardware");
  }
  if (independent) {
    notes.push(
      `independent volume readback from the platform's own store: ${independent.key} = ${independent.value} ` +
      "(read with vconftool, not from the adapter)",
    );
  } else {
    notes.push(
      "no independent volume readback (vconftool absent or a different key on this build) — " +
      "volume figures below are the adapter reporting on itself",
    );
  }
  if (noWrites) notes.push("run with --no-writes: mutating probes were skipped");

  const options = { allowWrites: !noWrites, notes };
  if (intents) options.intents = intents.split("|").map((s) => s.trim()).filter(Boolean);

  log("[report] collecting…");
  const result = await cdp.eval(`window.__hearthReport(${JSON.stringify(options)})`);
  if (!result?.markdown) throw new Error("the page returned no report");

  if (asJson) {
    process.stdout.write(JSON.stringify(result.report, null, 2) + "\n");
  } else {
    process.stdout.write(result.markdown + "\n");
  }

  const path = out ?? defaultPath(result.report);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.markdown + "\n", "utf8");
  log(`\n[report] written to ${path}`);
  log("[report] paste it into an issue, or open a PR adding it to docs/platform/capability-matrix.md");

  const caught = result.report.acceptedButDidNothing ?? [];
  if (caught.length) {
    log(`[report] ${caught.length} capability(s) accepted a command and did nothing — that is the interesting part`);
  }
} catch (err) {
  console.error(`[report] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (sdb && port) unforward(sdb, port);
}

function defaultPath(report) {
  const slug = `${report.device.os}-${report.device.model || "device"}`
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return join("docs", "platform", "reports", `${slug}.md`);
}
