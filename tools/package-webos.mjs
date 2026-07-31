#!/usr/bin/env node
/**
 * Builds the webOS app into an `.ipk` using the **webOS TV CLI**
 * (`@webos-tools/cli`, the `ares-*` commands).
 *
 *   node tools/package-webos.mjs [--out <dir>] [--ares-bin <dir with ares-package>]
 *
 * No account or certificate is needed to *build* an .ipk — webOS signs nothing at
 * this stage; installing on a TV needs Developer Mode and a session, which is a
 * device step (see docs/BRINGUP_CHECKLIST.md §4).
 *
 * Install the CLI however you prefer:
 *   npm i -g @webos-tools/cli          # then ares-package is on PATH
 *   npm i @webos-tools/cli             # local; pass --ares-bin ./node_modules/.bin
 * It is deliberately NOT a workspace dependency — ~500 packages for a packaging
 * step that most contributors never run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "apps", "webos-app");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const outDir = resolve(opt("--out", join(appDir, "dist-ipk")));
const ares = findAres(opt("--ares-bin", process.env.WEBOS_CLI_BIN));

/**
 * Prefer the CLI's own JS entry point over the `.bin` shim: Node refuses to
 * execFile a Windows `.cmd` (EINVAL) without a shell, and going through a shell
 * just to quote paths again is worse. Falls back to the shim on PATH.
 */
function findAres(binDir) {
  const relJs = join("@webos-tools", "cli", "bin", "ares-package.js");
  const roots = [
    binDir && resolve(binDir, ".."),          // …/node_modules/.bin → …/node_modules
    join(root, "node_modules"),
    join(appDir, "node_modules"),
  ].filter(Boolean);
  for (const r of roots) {
    const js = join(r, relJs);
    if (existsSync(js)) return { file: process.execPath, prefix: [js] };
  }
  const shim = process.platform === "win32" ? "ares-package.cmd" : "ares-package";
  if (binDir && existsSync(join(binDir, shim))) return { file: join(binDir, shim), prefix: [], shell: true };
  return { file: shim, prefix: [], shell: process.platform === "win32" };
}

function run(label, file, argv, cwd = appDir, shell = false) {
  process.stdout.write(`[webos] ${label}\n`);
  try {
    const out = execFileSync(file, argv, { cwd, encoding: "utf8", maxBuffer: 8 << 20, shell });
    if (out.trim()) process.stdout.write(indent(out.trim()) + "\n");
    return out;
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    fail(`${label} failed\n${indent(detail || String(err.message))}`);
  }
}
const indent = (s) => s.split("\n").map((l) => `        ${l}`).join("\n");
function fail(msg) {
  console.error(`\n[webos] ${msg}\n`);
  process.exit(1);
}

// 1. The runtime bundle the app loads.
run("bundling runtime → apps/webos-app/main.js", process.execPath, [join(root, "tools", "bundle.mjs"), "webos"], root);

// 2. appinfo.json references icon.png; without it the app has no launcher tile.
if (!existsSync(join(appDir, "icon.png"))) {
  run("generating icon.png", process.execPath, [join(root, "tools", "make-icon.mjs")], root);
}

// 3. Package. `-o` keeps the .ipk out of the source tree.
/**
 * ares-package packages *everything* in the app directory by default, which for a
 * pnpm workspace means the whole linked `node_modules` tree (every package's
 * dist and tsbuildinfo), the TypeScript source and the sourcemap — 290 KB of
 * which ~45 KB was the actual app. Ship only what the app loads at runtime.
 */
const EXCLUDE = ["node_modules", "src", "*.map", "package.json", "README.md", "dist-ipk"];

// `-n` (--no-minify, undocumented in --help) is required: ares-package runs the
// bundle through an old uglify-js that can't parse our ES2020 output and fails
// with "Failed to minify code". esbuild already minified it.
mkdirSync(outDir, { recursive: true });
run(
  `ares-package -n -o ${outDir}`,
  ares.file,
  [...ares.prefix, ".", "-n", ...EXCLUDE.flatMap((p) => ["-e", p]), "-o", outDir],
  appDir,
  ares.shell ?? false,
);

const ipk = readdirSync(outDir).filter((f) => f.endsWith(".ipk")).sort();
if (!ipk.length) fail("ares-package reported success but produced no .ipk");
const produced = join(outDir, ipk[ipk.length - 1]);
console.log(`\n[webos] package: ${produced}`);
console.log("[webos] install on a TV in Developer Mode:");
console.log("          ares-setup-device            # one-time device registration");
console.log(`          ares-install "${produced}" -d <device>`);
console.log("          ares-launch tv.aiagent.harness -d <device>");
console.log("          ares-inspect tv.aiagent.harness -d <device>   # devtools, for ?diag output");
