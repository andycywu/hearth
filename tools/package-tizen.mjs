#!/usr/bin/env node
/**
 * Builds and signs the Tizen web app into a `.wgt`, using **tizen-core** (`tz`) —
 * the CLI that ships with the Tizen VS Code extension. Tizen Studio is EOL; this
 * replaces the old `tizen build-web` / `tizen package` pair.
 *
 *   node tools/package-tizen.mjs [--profile <signing-profile>] [--tz <path/to/tz>]
 *                                [--flags "demo&confirm=auto"]
 *
 * `--flags` bakes a query string into the packaged start page, which is how you
 * get `?demo` / `?diag` / `?llm=` onto Tizen — it has no equivalent of Android's
 * `-e start` intent extra.
 *
 * One-time setup. This is enough to BUILD a signed .wgt; installing it on a
 * Samsung TV or its emulator additionally requires a **Samsung** certificate from
 * Certificate Manager (free Samsung account) — a generic Tizen cert is rejected
 * with "Operation not allowed : :Load archive info fail":
 *
 *   tz cert -n "<your name>" -p <password≥8> -f my-dev            # author cert
 *   tz security-profiles add -n my-dev -A \
 *     -a <tizen-studio-data>/keystore/author/my-dev.p12 -p <password> \
 *     -d <tizen-core>/certificates/distributor/tizen_public_signer.p12 \
 *     -P tizenpkcs12passfordsigner
 *
 * A **partner**-level certificate is a third, separate tier, needed only for the
 * privileged capabilities the POC deliberately leaves out — see docs/POC.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { findTizenSdk, findTizenSdks } from "./tizen-sdk.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "tizen-app");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
/** All values for a repeatable flag, in order. */
const optAll = (name) =>
  args.reduce((acc, a, i) => (a === name && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

const sdk = findTz(opt("--tz", process.env.TIZEN_CORE));
const tz = sdk.tz;
const profile = opt("--profile", null);   // null → tz uses the active profile
/**
 * Repeatable, and commas work too:
 *   --flags demo --flags confirm=auto      (preferred — no shell metacharacters)
 *   --flags "demo,confirm=auto"
 *   --flags "demo&confirm=auto"            (only when invoked via node directly:
 *                                           `pnpm run` goes through cmd on
 *                                           Windows, which eats a bare `&`)
 */
const flags = optAll("--flags").flatMap((f) => f.split(/[,&]/)).map((f) => f.trim()).filter(Boolean);

function findTz(explicit) {
  const chosen = findTizenSdk(explicit);
  if (!chosen) {
    fail(
      "tizen-core (tz) not found.\n" +
      "  Install the Tizen VS Code extension (Tizen Studio is EOL), then pass\n" +
      "  --tz <path/to/tz> or set TIZEN_CORE.",
    );
  }
  // Two SDKs on one machine is the trap: certificates made in VS Code live in
  // the extension's own sdk-data, and signing with the other install's profile
  // yields a package the device rejects — with an error that never mentions it.
  const all = findTizenSdks();
  if (all.length > 1 && !explicit) {
    console.log(`[tizen] ${all.length} Tizen SDKs found; using the ${chosen.kind} one:`);
    for (const s of all) console.log(`          ${s === all[0] ? "→" : " "} ${s.kind}  ${s.root}`);
    console.log("          (override with --tz <path/to/tz> or TIZEN_CORE)");
  } else {
    console.log(`[tizen] SDK: ${chosen.kind}  ${chosen.root}`);
  }
  return chosen;
}

function run(label, file, argv, cwd = appDir) {
  process.stdout.write(`[tizen] ${label}\n`);
  try {
    const out = execFileSync(file, argv, { cwd, encoding: "utf8", maxBuffer: 8 << 20 });
    if (out.trim()) process.stdout.write(indent(out.trim()) + "\n");
    return out;
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    fail(`${label} failed\n${indent(detail || String(err.message))}`);
  }
}
const indent = (s) => s.split("\n").map((l) => `        ${l}`).join("\n");
function fail(msg) {
  console.error(`\n[tizen] ${msg}\n`);
  process.exit(1);
}

// 1. The runtime bundle the app loads.
run("bundling runtime → apps/tizen-app/main.js", process.execPath, [join(root, "tools", "bundle.mjs"), "tizen"], root);

// 2. config.xml references icon.png; packaging fails without it.
if (!existsSync(join(appDir, "icon.png"))) {
  run("generating icon.png", process.execPath, [join(root, "tools", "make-icon.mjs")], root);
}

/**
 * Tizen has no equivalent of Android's `-e start` intent extra, so `?demo` /
 * `?diag` / `?llm=` have to be baked in at package time.
 *
 * The obvious way — `<content src="index.html?demo"/>` in config.xml — does NOT
 * work: the Tizen web runtime drops the query, and `location.search` is empty on
 * device. The app boots fine and silently ignores every flag, which is about the
 * worst failure mode available. Verified on the TV 10.0 emulator by putting the
 * flag source on screen: it read `flags:none`.
 *
 * So write them as a script instead. `launchSearch()` in @hearthkit/core reads
 * `__AGENT_FLAGS__` whenever there's no real query string, so a browser or an
 * `adb`-launched intent still wins over what was baked.
 */
const configPath = join(appDir, "config.xml");
const flagsPath = join(appDir, "launch-flags.js");
const query = flags.join("&");

if (flags.length) {
  writeFileSync(
    flagsPath,
    "// Generated by tools/package-tizen.mjs — do not edit, and do not commit.\n" +
    "// Tizen drops the query string from config.xml's <content src>, so launch\n" +
    "// flags arrive as a global instead. See packages/core/src/launch-flags.ts.\n" +
    `globalThis.__AGENT_FLAGS__ = ${JSON.stringify(query)};\n`,
    "utf8",
  );
  console.log(`[tizen] launch flags → __AGENT_FLAGS__ = "${query}"`);
} else {
  // A stale file from an earlier run would silently re-apply old flags.
  rmSync(flagsPath, { force: true });
}

/**
 * `--profile` has to go through the *active* profile.
 *
 * `tz pack -s <name>` looks like the way to pick a signing profile and isn't:
 * `-s` is flagged `[repack]` in `tz pack --help`, so it only applies when
 * re-signing an existing package. A normal pack silently uses whatever profile
 * is active — which meant `--profile` did nothing at all, and the package came
 * out signed by the wrong certificate with no warning. Set it, pack, put it
 * back, so this doesn't leave the toolchain reconfigured behind you.
 */
const previousProfile = profile ? activeProfile() : null;
let packOut;
try {
  if (profile && profile !== previousProfile) {
    run(`tz security-profiles set-active ${profile}`, tz, ["security-profiles", "set-active", profile]);
    console.log(`[tizen] signing profile: ${profile} (was ${previousProfile ?? "none"})`);
  }
  run("tz build", tz, ["build"]);
  pruneBuildOutput();
  packOut = run("tz pack -t wgt", tz, ["pack", "-t", "wgt"]);
} finally {
  // Don't leave a flagged build lying around for the next person to package.
  rmSync(flagsPath, { force: true });
  if (profile && previousProfile && profile !== previousProfile) {
    run(`tz security-profiles set-active ${previousProfile}`, tz,
      ["security-profiles", "set-active", previousProfile]);
  }
}

/**
 * Drop what `tz build` leaves behind that a television has no use for.
 *
 * A packaged .wgt was measured at 233 KB, of which **129,851 bytes — 56% — was
 * `.manifest.tmp`**, an SDK scratch file. The sourcemap is the same kind of
 * passenger: 300-odd KB of it, useful on a bench and dead weight on a TV, which
 * is why the webOS packager already excludes `*.map`.
 *
 * Between build and pack, because pack is what computes the signature digests:
 * removing a file afterwards would invalidate them, and removing it beforehand
 * simply means it is never signed and never shipped.
 */
function pruneBuildOutput() {
  const dirs = ["Debug", "Release", ".buildResult"]
    .map((d) => join(appDir, d))
    .filter((d) => existsSync(d));
  if (!dirs.length) return;

  let freed = 0;
  const dropped = [];
  for (const dir of dirs) {
    for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (file.name !== ".manifest.tmp" && !file.name.endsWith(".map")) continue;
      const path = join(file.parentPath ?? file.path, file.name);
      freed += statSync(path).size;
      rmSync(path, { force: true });
      dropped.push(file.name);
    }
  }
  if (dropped.length) {
    console.log(`[tizen] pruned ${dropped.join(", ")} before packing (${(freed / 1024).toFixed(1)} KB)`);
  }
}

function activeProfile() {
  const out = run("tz security-profiles list", tz, ["security-profiles", "list"]);
  return out.match(/Current Active Profile:\s*(\S+)/)?.[1] ?? null;
}

const match = packOut.match(/Package File Location:\s*(.+\.wgt)/i);
if (!match) {
  fail(
    "tz reported no package location.\n" +
    "  If it complained about a signing profile, create one first (see the header\n" +
    "  of this file) or pass --profile <name>.",
  );
}
const wgt = match[1].trim();
const size = statSync(wgt).size;
console.log(`\n[tizen] signed package: ${wgt} (${(size / 1024).toFixed(1)} KB)`);
// Print the paths from the SDK we actually used, so nobody mixes toolchains.
const sdb = sdk.sdb ?? "sdb";
console.log("[tizen] install on a device or emulator:");
console.log(`          "${sdb}" devices           # must list a target first`);
console.log(`          "${tz}" install -p "${wgt}"`);
// Read it rather than hardcode it — this hint went stale the moment the package
// id changed, and a wrong id here costs a confusing debugging session on the TV.
const packageId = readFileSync(configPath, "utf8").match(/package="([^"]+)"/)?.[1] ?? "<package-id>";
console.log(`          "${tz}" run -p ${packageId}   # package id from config.xml`);
