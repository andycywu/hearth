#!/usr/bin/env node
/**
 * `pnpm doctor` — tells you what's missing and the exact command that fixes it.
 *
 *   node tools/doctor.mjs [--strict]
 *
 * Every check here exists because someone (usually us) lost time to it: pnpm not
 * on PATH, a stale lockfile, no Gradle wrapper, an SDK with no TV image, an
 * emulator that won't launch without WHPX, a Tizen CLI with no signing profile.
 * A newcomer should hit a one-line fix, not an afternoon.
 *
 * Core checks are required; the per-platform sections only matter if you're
 * targeting that platform, so they warn rather than fail. `--strict` fails on
 * warnings too.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { findTizenSdk, findTizenSdks } from "./tizen-sdk.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const isWin = process.platform === "win32";

const OK = "ok", WARN = "warn", FAIL = "fail", SKIP = "skip";
const results = [];

/** Run a command, returning its trimmed output or undefined if it can't run. */
function tryExec(file, args, opts = {}) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000, ...opts,
    }).trim();
  } catch {
    return undefined;
  }
}
function onPath(cmd) {
  const probe = isWin ? tryExec("where", [cmd]) : tryExec("which", [cmd]);
  return probe ? probe.split(/\r?\n/)[0] : undefined;
}
function record(section, name, status, detail, fix) {
  results.push({ section, name, status, detail, fix });
}

// --- core ------------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);
record("Core", "Node ≥ 20", nodeMajor >= 20 ? OK : FAIL, `v${process.versions.node}`,
  "install Node 20+ (see .nvmrc)");

const pnpmPath = onPath(isWin ? "pnpm.cmd" : "pnpm") ?? onPath("pnpm");
record("Core", "pnpm on PATH", pnpmPath ? OK : FAIL,
  pnpmPath ?? "not found",
  isWin
    ? 'run `corepack enable pnpm` from an ELEVATED shell (it writes into the Node install dir)'
    : "corepack enable pnpm");

const nodeModules = existsSync(join(root, "node_modules"));
record("Core", "dependencies installed", nodeModules ? OK : FAIL,
  nodeModules ? "node_modules present" : "no node_modules", "pnpm install");

// A lockfile that predates a workspace package fails CI's --frozen-lockfile long
// before anyone notices locally.
const lock = existsSync(join(root, "pnpm-lock.yaml"))
  ? readFileSync(join(root, "pnpm-lock.yaml"), "utf8") : "";
const workspaceDirs = ["packages", "apps"].flatMap((d) => {
  const p = join(root, d);
  return existsSync(p)
    ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory())
        .map((e) => `${d}/${e.name}`)
    : [];
}).filter((d) => existsSync(join(root, d, "package.json")) && d !== "examples/blits-demo");
const missingFromLock = workspaceDirs.filter((d) => !lock.includes(`${d}:`));
record("Core", "lockfile covers every workspace package",
  missingFromLock.length === 0 ? OK : FAIL,
  missingFromLock.length ? `missing: ${missingFromLock.join(", ")}` : `${workspaceDirs.length} packages`,
  "pnpm install   # then commit pnpm-lock.yaml, or CI's --frozen-lockfile will fail");

const built = existsSync(join(root, "packages", "core", "dist", "index.js"));
record("Core", "packages built", built ? OK : WARN,
  built ? "packages/core/dist present" : "not built yet", "pnpm build");

// --- Android ---------------------------------------------------------------
const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ??
  (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined) ??
  (process.env.HOME ? join(process.env.HOME, "Android", "Sdk") : undefined);
const haveSdk = androidHome && existsSync(androidHome);
record("Android", "SDK found", haveSdk ? OK : WARN, haveSdk ? androidHome : "no ANDROID_HOME",
  "install Android Studio, or set ANDROID_HOME");

const javaHome = process.env.JAVA_HOME;
const javaBin = javaHome ? join(javaHome, "bin", isWin ? "java.exe" : "java") : onPath("java");
const javaVersion = javaBin && existsSync(javaBin) ? tryExec(javaBin, ["-version"]) : undefined;
// `java -version` writes to stderr, which we drop; presence is what matters.
record("Android", "JDK 17+", javaBin && existsSync(javaBin) ? OK : WARN,
  javaBin && existsSync(javaBin) ? javaBin : "no java / JAVA_HOME",
  isWin
    ? 'set JAVA_HOME="C:\\Program Files\\Android\\Android Studio\\jbr"   # Studio ships a JDK'
    : "export JAVA_HOME=<a JDK 17+>");

const adb = haveSdk ? join(androidHome, "platform-tools", isWin ? "adb.exe" : "adb") : undefined;
record("Android", "adb", adb && existsSync(adb) ? OK : WARN, adb ?? "-",
  "sdkmanager --install platform-tools");

if (haveSdk) {
  const imagesRoot = join(androidHome, "system-images");
  const tvImages = existsSync(imagesRoot)
    ? readdirSync(imagesRoot).filter((api) => existsSync(join(imagesRoot, api, "android-tv")))
    : [];
  record("Android", "TV system image", tvImages.length ? OK : WARN,
    tvImages.length ? tvImages.join(", ") : "none installed",
    'sdkmanager --install "system-images;android-34;android-tv;x86"   # TV images are x86 or arm64-v8a only');

  const avdHome = process.env.ANDROID_AVD_HOME ??
    (process.env.USERPROFILE ? join(process.env.USERPROFILE, ".android", "avd") : undefined) ??
    (process.env.HOME ? join(process.env.HOME, ".android", "avd") : undefined);
  const avds = avdHome && existsSync(avdHome)
    ? readdirSync(avdHome).filter((f) => f.endsWith(".avd")).map((f) => f.replace(/\.avd$/, ""))
    : [];
  record("Android", "AVD created", avds.length ? OK : WARN,
    avds.length ? avds.join(", ") : "none",
    'avdmanager create avd -n tv_agent -k "system-images;android-34;android-tv;x86" -d tv_1080p');

  // Without acceleration the emulator either refuses to start or is unusable.
  const emuCheck = join(androidHome, "emulator", isWin ? "emulator-check.exe" : "emulator-check");
  if (existsSync(emuCheck)) {
    const accel = tryExec(emuCheck, ["accel"]) ?? "";
    const accelOk = /is installed and usable/i.test(accel);
    record("Android", "emulator acceleration", accelOk ? OK : WARN,
      accelOk ? (accel.match(/^\s*(\S+).*is installed and usable/im)?.[1] ?? "available") : "unavailable",
      isWin ? "enable Windows Hypervisor Platform (and VT-x/AMD-V in BIOS)" : "install KVM");
  }
}

record("Android", "Gradle wrapper", existsSync(join(root, "apps", "aosp-app", "gradlew")) ? OK : FAIL,
  "apps/aosp-app/gradlew", "gradle wrapper --gradle-version 8.7");

if (adb && existsSync(adb)) {
  const devices = (tryExec(adb, ["devices"]) ?? "").split(/\r?\n/).slice(1)
    .filter((l) => /\tdevice$/.test(l)).map((l) => l.split("\t")[0]);
  record("Android", "device connected", devices.length ? OK : SKIP,
    devices.length ? devices.join(", ") : "none",
    "start an emulator, or `adb connect <TV_IP>:5555`");
}

// --- Tizen -----------------------------------------------------------------
const sdks = findTizenSdks();
const sdk = findTizenSdk();
record("Tizen", "tizen-core (tz)", sdk ? OK : SKIP,
  sdk ? `${sdk.kind}  ${sdk.root}` : "not installed",
  "install the Tizen VS Code extension (Tizen Studio is EOL)");

// Two installs is the single most confusing state this toolchain gets into:
// each has its own profiles.xml, so a certificate made in VS Code is invisible
// to the other, and signing with the wrong one fails at install with an error
// that never mentions certificates.
if (sdks.length > 1) {
  record("Tizen", "only one SDK", WARN,
    sdks.map((s) => `${s.kind} (${s.root})`).join("  +  "),
    "certs made in VS Code live in the extension's SDK — uninstall the other, " +
    "or pass --tz / TIZEN_CORE so every tool agrees");
}

if (sdk) {
  const profiles = tryExec(sdk.tz, ["security-profiles", "list"]) ?? "";
  const active = profiles.match(/Current Active Profile:\s*(\S+)/)?.[1];
  const names = [...profiles.matchAll(/^(\S+)\s*$/gm)].map((m) => m[1])
    .filter((n) => n !== "Distributor2:" && n !== active);
  record("Tizen", "signing profile", active ? OK : WARN,
    active ? `${active}${names.length ? ` (also: ${names.join(", ")})` : ""}` : "none",
    "VS Code → Tizen: Create Certificate  (its profiles.xml is the one tz reads)");

  // A generic Tizen distributor builds a package a Samsung TV will not install:
  // `install failed[118, -4] ... Load archive info fail`, which says nothing
  // about certificates. Catch it here instead of on the device.
  if (active && sdk.profilesXml && existsSync(sdk.profilesXml)) {
    const xml = readFileSync(sdk.profilesXml, "utf8");
    const block = xml.split(/<profile\s+name="/).find((b) => b.startsWith(`${active}"`)) ?? "";
    const distributor = block.match(/distributor="1"[^>]*?key="([^"]*)"/)?.[1]
      ?? block.match(/key="([^"]*)"[^>]*distributor="1"/)?.[1] ?? "";
    const generic = /tizen-distributor-signer|tizen_public_signer/i.test(distributor);
    record("Tizen", "certificate accepted by a TV", generic ? WARN : OK,
      generic ? "generic Tizen distributor" : (distributor.split(/[/\\]/).pop() || "unknown"),
      "a Samsung TV rejects this at install — VS Code → Tizen: Create Certificate, " +
      "pick the SAMSUNG type and device TV (free Samsung account; DUID is read from " +
      "the connected device)");
  }

  if (sdk.sdb) {
    const devices = (tryExec(sdk.sdb, ["devices"]) ?? "").split(/\r?\n/).slice(1)
      .filter((l) => /\tdevice\b/.test(l)).map((l) => l.split("\t")[0]);
    record("Tizen", "device/emulator", devices.length ? OK : SKIP,
      devices.length ? devices.join(", ") : "none",
      "VS Code → Tizen: Emulator Manager, or `sdb connect <TV_IP>`");
  }
}

// --- webOS -----------------------------------------------------------------
const aresJs = [
  join(root, "node_modules", "@webos-tools", "cli", "bin", "ares-package.js"),
  join(root, "apps", "webos-app", "node_modules", "@webos-tools", "cli", "bin", "ares-package.js"),
].find(existsSync);
const aresOnPath = onPath(isWin ? "ares-package.cmd" : "ares-package");
record("webOS", "webOS CLI (ares)", aresJs || aresOnPath ? OK : SKIP,
  aresJs ?? aresOnPath ?? "not installed", "npm i -g @webos-tools/cli");

// --- report ----------------------------------------------------------------
const icon = { [OK]: "✓", [WARN]: "!", [FAIL]: "✗", [SKIP]: "–" };
const width = Math.max(...results.map((r) => r.name.length));
let section = "";
for (const r of results) {
  if (r.section !== section) {
    section = r.section;
    console.log(`\n${section}`);
  }
  console.log(`  ${icon[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
  if (r.status === FAIL || r.status === WARN) console.log(`      → ${r.fix}`);
}

const failed = results.filter((r) => r.status === FAIL);
const warned = results.filter((r) => r.status === WARN);
console.log(
  `\n${failed.length ? "✗" : "✓"} ${results.filter((r) => r.status === OK).length} ok · ` +
  `${warned.length} warnings · ${failed.length} problems · ` +
  `${results.filter((r) => r.status === SKIP).length} not set up (fine unless you need them)\n`,
);
if (!failed.length && !warned.length) console.log("Everything the core dev loop needs is in place.\n");

process.exit(failed.length || (strict && warned.length) ? 1 : 0);
