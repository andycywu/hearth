#!/usr/bin/env node
/**
 * Builds and signs the Tizen web app into a `.wgt`, using **tizen-core** (`tz`) —
 * the CLI that ships with the Tizen VS Code extension. Tizen Studio is EOL; this
 * replaces the old `tizen build-web` / `tizen package` pair.
 *
 *   node tools/package-tizen.mjs [--profile <signing-profile>] [--tz <path/to/tz>]
 *
 * One-time setup, no Samsung account required for a public-level app:
 *
 *   tz cert -n "<your name>" -p <password≥8> -f my-dev            # author cert
 *   tz security-profiles add -n my-dev -A \
 *     -a <tizen-studio-data>/keystore/author/my-dev.p12 -p <password> \
 *     -d <tizen-core>/certificates/distributor/tizen_public_signer.p12 \
 *     -P tizenpkcs12passfordsigner
 *
 * A **partner**-level certificate (the Samsung-account flow) is only needed for
 * the privileged capabilities the POC deliberately leaves out — see docs/POC.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "tizen-app");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const tz = findTz(opt("--tz", process.env.TIZEN_CORE));
const profile = opt("--profile", null);   // null → tz uses the active profile

function findTz(explicit) {
  const candidates = [
    explicit,
    process.env.LOCALAPPDATA && join("C:", "tizen-studio", "tools", "tizen-core", "tz.exe"),
    "C:\\tizen-studio\\tools\\tizen-core\\tz.exe",
    process.env.HOME && join(process.env.HOME, "tizen-studio", "tools", "tizen-core", "tz"),
    "/opt/tizen-studio/tools/tizen-core/tz",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  fail(
    "tizen-core (tz) not found.\n" +
    "  Install the Tizen VS Code extension (Tizen Studio is EOL), then pass\n" +
    "  --tz <path/to/tz> or set TIZEN_CORE.",
  );
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

// 3. Compile/collect the web project, then package and sign.
run("tz build", tz, ["build"]);
const packArgs = ["pack", "-t", "wgt", ...(profile ? ["-s", profile] : [])];
const packOut = run(`tz ${packArgs.join(" ")}`, tz, packArgs);

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
console.log("[tizen] install on a device or emulator:");
console.log(`          sdb connect <TV_IP>      # or start an emulator`);
console.log(`          tz install -n "${wgt}"`);
