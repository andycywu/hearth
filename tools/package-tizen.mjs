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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

const tz = findTz(opt("--tz", process.env.TIZEN_CORE));
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

/**
 * Tizen has no equivalent of Android's `-e start` intent extra: the start page is
 * fixed in config.xml, so `?demo` / `?diag` / `?llm=` otherwise mean hand-editing
 * XML and repackaging.
 *
 * It has to be the *source* config.xml, briefly: `tz pack` re-copies the project
 * into Debug/projects/, so patching the staged copy is silently undone. The
 * original is restored in the `finally` below, whatever happens.
 */
const configPath = join(appDir, "config.xml");
const originalConfig = flags.length ? readFileSync(configPath, "utf8") : null;

if (originalConfig !== null) {
  const query = flags.join("&amp;");   // `&` is not legal raw in an XML attribute
  const patched = originalConfig.replace(
    /<content\s+src="index\.html[^"]*"\s*\/>/,
    `<content src="index.html?${query}"/>`,
  );
  if (patched === originalConfig) fail('couldn\'t find <content src="index.html"/> in config.xml');
  writeFileSync(configPath, patched, "utf8");
  console.log(`[tizen] start page → index.html?${flags.join("&")}`);
}

// 3. Compile/collect the web project, then package and sign.
let packOut;
try {
  run("tz build", tz, ["build"]);
  const packArgs = ["pack", "-t", "wgt", ...(profile ? ["-s", profile] : [])];
  packOut = run(`tz ${packArgs.join(" ")}`, tz, packArgs);
} finally {
  if (originalConfig !== null) writeFileSync(configPath, originalConfig, "utf8");
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
console.log("[tizen] install on a device or emulator:");
console.log("          sdb connect <TV_IP>      # or start an emulator");
console.log("          sdb devices              # must list a target first");
console.log(`          tz install -p "${wgt}"`);
console.log("          tz run -p tvaiagent      # package id from config.xml");
