#!/usr/bin/env node
/**
 * Runs the acceptance script from `packages/acceptance` against a REAL (or
 * emulated) Android device, and asserts the same tool sequence and end state.
 *
 *   node tools/device-acceptance.mjs [--serial emulator-5554] [--json]
 *
 * CI proves the script behaves identically across adapters with mocks. This
 * proves it on a device: same commands, same expected tool sequence, same final
 * volume/mute — but through the real WebView, the real Kotlin bridge and the real
 * AudioManager. It talks to the app's WebView over the Chrome DevTools Protocol
 * (the transport behind chrome://inspect), so nothing has to be typed by hand.
 *
 * Prerequisites:
 *   pnpm bundle:aosp && (cd apps/aosp-app && ./gradlew :app:assembleDebug)
 *   adb install -r apps/aosp-app/app/build/outputs/apk/debug/app-debug.apk
 *   node tools/mock-llm-server.mjs        # or point --llm at a real endpoint
 *   adb reverse tcp:8080 tcp:8080         # so the device's 127.0.0.1 is this host
 *
 * The app is launched with `?confirm=auto` because launching an app is a
 * confirm-required tool and no one is here to press a native dialog.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = [
  "set volume to 30",
  "make it louder",
  "mute",
  "open Netflix",
  "what's the volume?",
];
const EXPECTED_TOOLS = [
  "set_volume",
  "get_volume", "set_volume",
  "set_mute",
  "search_app_by_name", "launch_app",
  "get_volume",
];
const EXPECTED_END = { volume: 40, muted: true };

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const serial = opt("--serial", null);
const pkg = opt("--package", "tv.titanos.aiagent");
const activity = opt("--activity", ".MainActivity");
const llm = opt("--llm", "http://127.0.0.1:8080/v1");
const port = Number(opt("--port", 9222));
const asJson = has("--json");
const skipZh = has("--no-zh");

const adb = findAdb();
const log = (...a) => { if (!asJson) console.log(...a); };

// --- adb plumbing ---------------------------------------------------------
function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, "platform-tools", "adb.exe"),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe"),
    process.env.HOME && join(process.env.HOME, "Android", "Sdk", "platform-tools", "adb"),
    "adb",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "adb" || existsSync(c)) return c;
  }
  throw new Error("adb not found — set ANDROID_HOME or put adb on PATH");
}
function sh(...argv) {
  const full = serial ? ["-s", serial, ...argv] : argv;
  return execFileSync(adb, full, { encoding: "utf8", maxBuffer: 8 << 20 }).trim();
}

/**
 * The WebView exposes devtools on an abstract unix socket named after its pid.
 * Match it to our package so a second WebView app on the device can't confuse us.
 */
function webViewSocket() {
  const pid = sh("shell", "pidof", pkg).split(/\s+/)[0];
  const unix = sh("shell", "cat", "/proc/net/unix");
  const names = [...unix.matchAll(/@?(webview_devtools_remote_\d+)/g)].map((m) => m[1]);
  const mine = pid ? names.find((n) => n.endsWith(`_${pid}`)) : undefined;
  const socket = mine ?? names[0];
  if (!socket) {
    throw new Error(
      "no WebView devtools socket — is the app running? " +
      "(a release/non-debuggable build doesn't expose one)",
    );
  }
  return socket;
}

// --- CDP client (Node's built-in WebSocket; no dependencies) --------------
class Cdp {
  #ws; #next = 1; #pending = new Map();
  consoleLines = [];

  static async connect(wsUrl) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener("open", resolve, { once: true });
      cdp.#ws.addEventListener("error", () => reject(new Error(`cannot open ${wsUrl}`)), { once: true });
    });
    cdp.#ws.addEventListener("message", (ev) => cdp.#onMessage(String(ev.data)));
    await cdp.send("Runtime.enable");
    return cdp;
  }

  #onMessage(data) {
    const msg = JSON.parse(data);
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      this.consoleLines.push(`[${msg.params.type}] ${text}`);
    }
  }

  send(method, params = {}) {
    const id = this.#next++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** Evaluate in the page and return the value, throwing page exceptions. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error(`page error: ${e.exception?.description ?? e.text}`);
    }
    return r.result?.value;
  }

  close() { this.#ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && /android_asset/.test(t.url ?? ""));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* devtools not up yet */ }
    await sleep(500);
  }
  throw new Error("no WebView page target found on the devtools endpoint");
}

// --- the run --------------------------------------------------------------
const results = { device: {}, tools: [], turns: [], end: {}, zh: null, pass: false };

try {
  log(`[device] adb: ${adb}${serial ? ` (${serial})` : ""}`);
  log(`[device] launching ${pkg}${activity} with ?confirm=auto&llm=${llm}`);

  // Restart the app so state is clean and the query flags apply.
  sh("shell", "am", "force-stop", pkg);
  sh("shell", "am", "start", "-n", `${pkg}/${activity}`,
     "-e", "start", `index.html?confirm=auto&llm=${llm}`);
  await sleep(2500);

  const socket = webViewSocket();
  log(`[device] webview socket: ${socket}`);
  try { sh("forward", "--remove", `tcp:${port}`); } catch { /* nothing to remove */ }
  sh("forward", `tcp:${port}`, `localabstract:${socket}`);

  const target = await findPageTarget();
  log(`[device] page: ${target.url}`);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  // Wait for boot() to publish the agent.
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await cdp.eval("!!(window.__tvAgent && window.__tvPlatform)");
    if (!ready) await sleep(500);
  }
  if (!ready) {
    throw new Error(
      "window.__tvAgent never appeared — check `adb logcat -s chromium:I` " +
      "(a bundle or bridge error at boot)",
    );
  }

  results.device = await cdp.eval("JSON.stringify(window.__tvPlatform.device)").then(JSON.parse);
  log(`[device] ${results.device.os} ${results.device.osVersion} · ${results.device.model} · soc=${results.device.soc}`);

  // Record every tool call the way the CI acceptance test does.
  await cdp.eval(`(() => {
    window.__probe = { tools: [], errors: [] };
    window.__tvAgent.events.on("tool:call", (e) => window.__probe.tools.push(e.name));
    window.__tvAgent.events.on("error", (e) => window.__probe.errors.push(String(e.error && e.error.message)));
    return true;
  })()`);

  for (const command of SCRIPT) {
    const output = await cdp.eval(`window.__tvAgent.run(${JSON.stringify(command)})`);
    results.turns.push({ command, output });
    log(`  ▸ ${command}\n    → ${output}`);
  }

  const probe = JSON.parse(await cdp.eval("JSON.stringify(window.__probe)"));
  results.tools = probe.tools;
  results.errors = probe.errors;

  results.end = {
    volume: await cdp.eval("window.__tvPlatform.system.getVolume()"),
    muted: await cdp.eval("window.__tvPlatform.system.getMute()"),
  };

  // The Chinese path exercises language detection on the device engine.
  if (!skipZh) {
    const zhSet = await cdp.eval('window.__tvAgent.run("音量調到 30")');
    const zhAsk = await cdp.eval('window.__tvAgent.run("現在音量多少?")');
    results.zh = { set: zhSet, ask: zhAsk, ok: /音量/.test(zhAsk) && /30/.test(zhAsk) };
    log(`  ▸ 音量調到 30 / 現在音量多少?\n    → ${zhSet} / ${zhAsk}`);
  }

  cdp.close();
  try { sh("forward", "--remove", `tcp:${port}`); } catch { /* ignore */ }

  // --- verdict ---
  const toolsMatch = JSON.stringify(results.tools) === JSON.stringify(EXPECTED_TOOLS);
  const endMatch = results.end.volume === EXPECTED_END.volume && results.end.muted === EXPECTED_END.muted;
  const zhOk = skipZh || results.zh?.ok === true;
  results.pass = toolsMatch && endMatch && zhOk && (results.errors?.length ?? 0) === 0;

  if (asJson) {
    console.log(JSON.stringify({ ...results, expected: { tools: EXPECTED_TOOLS, end: EXPECTED_END } }, null, 2));
  } else {
    console.log("\n--- verdict ---");
    console.log(`tool sequence : ${toolsMatch ? "MATCH" : "MISMATCH"}`);
    if (!toolsMatch) {
      console.log(`  expected: ${EXPECTED_TOOLS.join(", ")}`);
      console.log(`  actual  : ${results.tools.join(", ")}`);
    }
    console.log(`end state     : volume=${results.end.volume} muted=${results.end.muted} ` +
                `(expected ${EXPECTED_END.volume}/${EXPECTED_END.muted}) ${endMatch ? "OK" : "WRONG"}`);
    if (!skipZh) console.log(`chinese replies: ${zhOk ? "OK" : "WRONG"}`);
    if (results.errors?.length) console.log(`agent errors  : ${results.errors.join(" | ")}`);
    console.log(`\n${results.pass ? "PASS" : "FAIL"} — on-device behaviour ${results.pass ? "matches" : "differs from"} the CI baseline\n`);
  }
  process.exit(results.pass ? 0 : 1);
} catch (err) {
  if (asJson) console.log(JSON.stringify({ ...results, error: String(err.message ?? err) }, null, 2));
  else console.error(`\n[device] FAILED: ${err.message ?? err}\n`);
  process.exit(2);
}
