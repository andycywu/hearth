#!/usr/bin/env node
/**
 * Build the input probe, put it on a Tizen television, and read what the page found.
 *
 *   node tools/experiments/tizen-input-probe/run.mjs [--profile tizen-dev|SamsungCerti] [--no-install]
 *   node tools/experiments/tizen-input-probe/run.mjs --switch HDMI:2 --yes-switch   # changes what the TV shows
 *
 * Reads only, unless `--switch TYPE:N --yes-switch` is given: switching changes the picture, so it needs both words. The question
 * it answers is whether a page on this set can read its inputs (`webapis.tvinfo`, `tizen.tvwindow`, `systeminfo VIDEOSOURCE`) and
 * switch them (`tizen.tvwindow.setSource`) — and under which signing profile. See docs/platform/free-my-tv-reference.md.
 *
 * The result is printed and written to results/<profile>-<time>.json. It says what the television *answered*; a refusal is a
 * result, and a missing API is a result. Nothing is inferred from the documentation.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findTizenSdk } from "../../tizen-sdk.mjs";
import {
  Cdp, findPageTarget, findSdb, forwardInspector, launchWithInspector, requireDevice, sdbFor, sleep, unforward, waitFor,
} from "../../tizen-device.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const profile = opt("--profile", null);
const appId = "tvprobe000.InputProbe";

const sdk = findTizenSdk();
if (!sdk) { console.error("tizen-core (tz) not found: install the Tizen VS Code extension"); process.exit(1); }
const tz = sdk.tz;
const run = (label, argv, cwd = here) => {
  process.stdout.write(`[probe] ${label}\n`);
  try { return execFileSync(tz, argv, { cwd, encoding: "utf8", maxBuffer: 8 << 20 }); }
  catch (err) { console.error([err.stdout, err.stderr].filter(Boolean).join("\n") || err.message); process.exit(1); }
};
const activeProfile = () => run("tz security-profiles list", ["security-profiles", "list"]).match(/Current Active Profile\S*:\s*(\S+)/)?.[1] ?? null;

// ---- the device
const sdb = sdbFor(findSdb());
requireDevice(sdb);
const info = sdb.shq("capability");
console.log(`[probe] device: ${sdb.shq("devices").split("\n").slice(1).join(" ").trim()}`);

// ---- build, sign, install
if (!args.includes("--no-install")) {
  const before = profile ? activeProfile() : null;
  try {
    if (profile && profile !== before) run(`tz security-profiles set-active ${profile}`, ["security-profiles", "set-active", profile]);
    const signedWith = activeProfile();
    console.log(`[probe] signing profile: ${signedWith}`);
    rmSync(join(here, "Debug"), { recursive: true, force: true });
    run("tz build", ["build"]);
    const out = run("tz pack -t wgt", ["pack", "-t", "wgt"]);
    const wgt = out.match(/Package File Location:\s*(.+\.wgt)/i)?.[1]?.trim();
    if (!wgt) { console.error("tz reported no package"); process.exit(1); }
    const installed = run("tz install", ["install", "-p", wgt]);
    console.log(installed.trim().split("\n").slice(-3).map((l) => `        ${l}`).join("\n"));
  } finally {
    if (profile && before && profile !== before) run(`tz security-profiles set-active ${before}`, ["security-profiles", "set-active", before]);
  }
}

// ---- run it with the Web Inspector and read the page
const launched = launchWithInspector(sdb, appId);
console.log(`[probe] launched: ${launched.via}  (inspector port ${launched.port})`);
forwardInspector(sdb, launched.port);
let report;
try {
  const target = await findPageTarget(launched.port);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  cdp.timeoutMs = 20_000;
  if (!(await waitFor(cdp, "!!(window.__probe && window.__probe.done)", 60))) throw new Error("the probe page did not finish");
  report = JSON.parse(await cdp.eval("JSON.stringify(window.__probe)"));

  const sw = opt("--switch", null);
  if (sw) {
    if (!args.includes("--yes-switch")) {
      console.error(`[probe] --switch ${sw} would change what the television shows; add --yes-switch to do it. Not switching.`);
    } else {
      // A comma list is a sequence ("HDMI:3,HDMI:1"). Whatever the television was on at the start is put back at the end,
      // whether or not the sequence worked.
      const original = JSON.parse(await cdp.eval("JSON.stringify((function(){ try { return tizen.tvwindow.getSource(); } catch (e) { return null; } })())"));
      report.switchSequence = [];
      const one = async (type, number) => {
        console.log(`[probe] switching to ${type} ${number} — the television's picture will change`);
        await cdp.eval(`window.__probeSwitch(${JSON.stringify(type)}, ${Number(number)})`);
        for (let i = 0; i < 30; i++) {
          const r = JSON.parse(await cdp.eval("JSON.stringify(window.__probe.switchResult || null)"));
          if (r) return r;
          await sleep(500);
        }
        return { error: "no answer from setSource in 15 s (neither success nor error callback)" };
      };
      for (const part of sw.split(",")) {
        const [type, number] = part.split(":");
        report.switchSequence.push(await one(type, number));
      }
      const now = JSON.parse(await cdp.eval("JSON.stringify((function(){ try { return tizen.tvwindow.getSource(); } catch (e) { return null; } })())"));
      if (original && now && (original.type !== now.type || original.number !== now.number)) {
        console.log(`[probe] putting the television back on ${original.type} ${original.number}`);
        report.switchSequence.push({ restore: true, ...(await one(original.type, original.number)) });
      }
      report.switchResult = report.switchSequence;
    }
  }
  cdp.close();
} finally {
  unforward(sdb, launched.port);
}

// ---- say it plainly
const verdict = (e) => (e && e.ok === true ? "answered" : e && e.ok === false ? `refused: ${JSON.stringify(e.error ?? e.threw)}` : `${JSON.stringify(e)}`);
console.log("\n=== what the television said ===");
for (const s of report.steps) console.log(`${s.name.padEnd(42)} ${typeof s.value === "object" && s.value && "ok" in s.value ? verdict(s.value) : JSON.stringify(s.value).slice(0, 160)}`);
if (report.switchResult) console.log(`${"tvwindow.setSource".padEnd(42)} ${JSON.stringify(report.switchResult)}`);

mkdirSync(join(here, "results"), { recursive: true });
const file = join(here, "results", `${profile ?? "active"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ profile: profile ?? "active", capability: info.split("\n").filter((l) => /intershell|sdk_toolpath|platform_version|profile_name|secure_protocol/.test(l)), report }, null, 2));
console.log(`\n[probe] written: ${resolve(file)}`);
