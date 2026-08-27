#!/usr/bin/env node
/**
 * Turns an attached Android TV into a pasteable Hearth Report section.
 *
 *   node tools/device-report.mjs [--serial emulator-5554] [--out docs/platform/reports/my-tv.md]
 *
 * The most valuable contribution to this project is a report from a television
 * nobody here owns — so the path from "I have a TV" to "here is a PR" has to be
 * one command. This launches the app in goal mode, asks the page for a report
 * over the devtools protocol, and writes markdown that needs no editing.
 *
 * The formatting happens *on the device*, by the same code every host ships
 * (`exposeDeviceReport`). This script only carries the answer back, so a report
 * produced by hand in a browser console is byte-identical to one produced here.
 *
 * Prerequisites (same as tools/device-acceptance.mjs):
 *   pnpm bundle:aosp && (cd apps/aosp-app && ./gradlew :app:assembleDebug)
 *   adb install -r apps/aosp-app/app/build/outputs/apk/debug/app-debug.apk
 *
 * `?confirm=auto` is passed because gated actions would otherwise wait on a
 * native dialog nobody is here to press. `?room=demo` seeds a console on HDMI2 so
 * the multi-device scenario has something to plan for on a device with nothing
 * plugged in — say so in the report if you leave it on.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const serial = opt("--serial", null);
const pkg = opt("--package", "tv.aiagent.harness");
const activity = opt("--activity", ".MainActivity");
const port = Number(opt("--port", 9222));
const out = opt("--out", null);
const room = opt("--room", "demo");
const intents = opt("--intents", null);
const noWrites = has("--no-writes");
const asJson = has("--json");

const adb = findAdb();
const log = (...a) => { if (!asJson) console.error(...a); };

function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, "platform-tools", "adb.exe"),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe"),
    process.env.HOME && join(process.env.HOME, "Android", "Sdk", "platform-tools", "adb"),
    "adb",
  ].filter(Boolean);
  for (const c of candidates) if (c === "adb" || existsSync(c)) return c;
  throw new Error("adb not found — set ANDROID_HOME or put adb on PATH");
}
function sh(...argv) {
  const full = serial ? ["-s", serial, ...argv] : argv;
  return execFileSync(adb, full, { encoding: "utf8", maxBuffer: 8 << 20 }).trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The WebView's devtools socket, matched to our pid so a second app can't
 * confuse us — retried, because a freshly booted device takes its time.
 *
 * Found the hard way: on a cold emulator the socket appears several seconds
 * after `am start` returns, and failing on the first look reported "is the app
 * running?" about an app that was starting perfectly well.
 */
async function waitForWebViewSocket(attempts = 20) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return webViewSocket();
    } catch (err) {
      last = err;
      await sleep(500);
    }
  }
  throw last;
}

function webViewSocket() {
  const pid = sh("shell", "pidof", pkg).split(/\s+/)[0];
  const unix = sh("shell", "cat", "/proc/net/unix");
  const names = [...unix.matchAll(/@?(webview_devtools_remote_\d+)/g)].map((m) => m[1]);
  const socket = (pid ? names.find((n) => n.endsWith(`_${pid}`)) : undefined) ?? names[0];
  if (!socket) {
    throw new Error(
      "no WebView devtools socket — is the app running? " +
      "(a release/non-debuggable build doesn't expose one)",
    );
  }
  return socket;
}

/** Minimal CDP client over Node's built-in WebSocket. No dependencies. */
class Cdp {
  #ws; #next = 1; #pending = new Map();

  static async connect(wsUrl) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener("open", resolve, { once: true });
      cdp.#ws.addEventListener("error", () => reject(new Error(`cannot open ${wsUrl}`)), { once: true });
    });
    cdp.#ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id && cdp.#pending.get(msg.id);
      if (!p) return;
      cdp.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
    await cdp.#send("Runtime.enable");
    return cdp;
  }

  #send(method, params = {}) {
    const id = this.#next++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const r = await this.#send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error(`page error: ${e.exception?.description ?? e.text}`);
    }
    return r.result?.value;
  }

  close() { this.#ws.close(); }
}

async function findPageTarget() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && /appassets\.androidplatform\.net|android_asset/.test(t.url ?? ""),
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* devtools not up yet */ }
    await sleep(500);
  }
  throw new Error("no WebView page target found on the devtools endpoint");
}

let cdp;
try {
  log(`[report] adb: ${adb}${serial ? ` (${serial})` : ""}`);
  const flags = `index.html?plan\\&confirm=auto\\&render=overlay\\&room=${room}`;
  log(`[report] launching ${pkg}/${activity} with ${flags.replace(/\\/g, "")}`);
  sh("shell", "am", "start", "-n", `${pkg}/${activity}`, "-e", "start", flags);
  await sleep(2500);

  const socket = await waitForWebViewSocket();
  try { sh("forward", "--remove", `tcp:${port}`); } catch { /* nothing to remove */ }
  sh("forward", `tcp:${port}`, `localabstract:${socket}`);
  const target = await findPageTarget();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  // Wait for the host to finish booting and expose the helper, rather than
  // guessing at a sleep: a slow device would otherwise fail here for a reason
  // that says nothing about the device.
  let ready = false;
  for (let attempt = 0; attempt < 20 && !ready; attempt++) {
    ready = await cdp.eval("typeof window.__hearthReport === 'function'");
    if (!ready) await sleep(500);
  }
  if (!ready) {
    throw new Error(
      "the page never exposed __hearthReport.\n" +
      "  The default build does not carry the diagnostics — they are 7.9 KB that a\n" +
      "  working television never runs. Rebuild the bundle with them and reinstall:\n" +
      "      node tools/bundle.mjs aosp --with diag\n" +
      "  (or --full for every optional feature). See packages/core/src/features.ts.",
    );
  }

  const options = {
    allowWrites: !noWrites,
    notes: [
      `collected by tools/device-report.mjs with ?plan&confirm=auto&room=${room}`,
      ...(room === "demo" ? ["the PS5/STB in the room section are seeded by `?room=demo`, not real hardware"] : []),
      ...(noWrites ? ["run with --no-writes: mutating probes were skipped"] : []),
    ],
  };
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
}

function defaultPath(report) {
  const slug = `${report.device.os}-${report.device.model || "device"}`
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return join("docs", "platform", "reports", `${slug}.md`);
}
