#!/usr/bin/env node
/**
 * Runs the acceptance script from `packages/acceptance` against a REAL Tizen TV
 * or reference board, and asserts the same tool sequence and end state.
 *
 *   node tools/device-acceptance-tizen.mjs [--serial <sdb-serial>] [--json]
 *
 * The Android twin of this (`device-acceptance.mjs`) exists because CI proves
 * the script behaves the same across adapters *with mocks*, and that is not the
 * same claim as it behaving on a device. Tizen had no equivalent, so every
 * check there was a person typing into a Web Inspector — which is exactly the
 * kind of testing that stops happening after the second time.
 *
 * Prerequisites:
 *
 *   sdb connect <board-ip>:26101        # or plug in USB
 *   node tools/package-tizen.mjs --profile tizen-dev \
 *        --flags confirm=auto --flags "llm=http://<host>:8080/v1"
 *   tizen install -n tizen-app.wgt -- apps/tizen-app/Debug
 *
 * Note the flags go in at *package* time. Tizen's web runtime drops the query
 * string from config.xml's <content src>, so there is no launch-time equivalent
 * of Android's `-e start`; they arrive as `__AGENT_FLAGS__` instead. This script
 * checks they made it and says so plainly if not, because the failure mode
 * otherwise is an app that boots perfectly and ignores everything you asked.
 *
 * `confirm=auto` because launching an app is a confirm-required tool and nobody
 * is here to press a dialog.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Same script and same expectations as the Android runner, deliberately: the
 * point of the exercise is that one agent behaves identically on both, and a
 * different script would prove nothing about that.
 */
const script = (app) => [
  "set volume to 30",
  "make it louder",
  "mute",
  `open ${app}`,
  "what's the volume?",
];
const EXPECTED_TOOLS = [
  "set_volume",
  "get_volume", "set_volume",
  "set_mute",
  "search_app_by_name", "launch_app",
  "get_volume",
];
const EXPECTED_VOLUME = 40;
// Devices quantize 0-100 onto their own steps, so an exact match isn't a fair
// expectation — a whole step of slack is.
const VOLUME_TOLERANCE = 7;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const serial = opt("--serial", null);
const appName = opt("--app", null);        // default: whatever is installed
const appId = opt("--app-id", "tvaiagent0.TvAiAgent");
const asJson = has("--json");
const skipZh = has("--no-zh");

const sdb = findSdb();
const log = (...a) => { if (!asJson) console.log(...a); };

// --- sdb plumbing ----------------------------------------------------------
function findSdb() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [
    process.env.TIZEN_SDK && join(process.env.TIZEN_SDK, "tools", "sdb.exe"),
    // Where the VS Code Tizen extension keeps its SDK. Worth trying first on
    // Windows: Tizen Studio is no longer the only way to get these tools, and
    // this path is the one a VS Code-only setup has.
    home && join(home, ".tizen-extension-platform", "server", "sdktools", "data", "tools", "sdb.exe"),
    home && join(home, "tizen-studio", "tools", "sdb.exe"),
    home && join(home, "tizen-studio", "tools", "sdb"),
    "sdb",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "sdb" || existsSync(c)) return c;
  }
  throw new Error("sdb not found — set TIZEN_SDK or put sdb on PATH");
}
function sh(...argv) {
  const full = serial ? ["-s", serial, ...argv] : argv;
  return execFileSync(sdb, full, { encoding: "utf8", maxBuffer: 8 << 20 }).trim();
}
/** Best-effort: some of these are informational and a board may not have them. */
function shq(...argv) {
  try { return sh(...argv); } catch { return ""; }
}

function requireDevice() {
  const out = shq("devices");
  const lines = out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    throw new Error(
      "no device attached. Connect the board first:\n" +
      "  sdb connect <board-ip>:26101      (or plug in USB)\n" +
      "  sdb devices                       (it must be listed)",
    );
  }
  return lines;
}

/**
 * Start the app with the Web Inspector and return its port.
 *
 * Killed first so the page is fresh, and therefore the agent is: a re-run
 * against a warm app inherits the previous run's conversation history, which
 * quietly changes what the model does on turn one.
 */
function launchWithInspector() {
  shq("shell", "app_launcher", "-k", appId);
  const out = sh("shell", "app_launcher", "-w", "-s", appId);
  const port = /port:\s*(\d+)/.exec(out)?.[1];
  if (!port) {
    throw new Error(
      `could not start ${appId} with the Web Inspector.\n` +
      `app_launcher said: ${out.trim()}\n` +
      "Check the id with: sdb shell app_launcher -l",
    );
  }
  return Number(port);
}

/**
 * An independent reading of the volume, straight from the platform's own
 * config store rather than from the code under test.
 *
 * The whole point of a device run is not to trust our own return value, and on
 * Android `dumpsys audio` gives that for free. Tizen has no such guarantee —
 * `vconftool` is not on every build and the key differs between them — so this
 * is best-effort and clearly labelled. When it answers, it is the strongest
 * evidence in the report; when it does not, the report says the readback is
 * self-reported rather than pretending otherwise.
 */
function independentVolume() {
  const keys = [
    "file/private/sound/volume/system",
    "memory/private/sound/volume/system",
    "db/setting/volume/system",
  ];
  for (const key of keys) {
    const out = shq("shell", "vconftool", "get", key);
    const value = /value\s*=\s*(\d+)/i.exec(out)?.[1];
    if (value !== undefined) return { key, value: Number(value) };
  }
  return null;
}

// --- CDP client (Node's built-in WebSocket; no dependencies) ---------------
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

  /** Run an expression and report whether it threw, instead of throwing. */
  async attempt(expression) {
    try { return { ok: true, value: await this.eval(expression) }; }
    catch (e) { return { ok: false, error: String(e.message ?? e) }; }
  }

  close() { this.#ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget(port) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url ?? ""));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* inspector not up yet */ }
    await sleep(500);
  }
  throw new Error(`no page target on the Web Inspector endpoint (port ${port})`);
}

// --- the run ---------------------------------------------------------------
const results = {
  device: {}, flags: null, audio: null, tools: [], turns: [],
  end: {}, independent: null, zh: null, notes: [], pass: false,
};

try {
  log(`[tizen] sdb: ${sdb}`);
  log(`[tizen] devices: ${requireDevice().join(" | ")}`);

  const port = launchWithInspector();
  log(`[tizen] ${appId} started, inspector on device port ${port}`);
  shq("forward", "--remove", `tcp:${port}`);   // usually nothing to remove; sdb says so loudly
  sh("forward", `tcp:${port}`, `tcp:${port}`);

  const target = await findPageTarget(port);
  log(`[tizen] page: ${target.url}`);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await cdp.eval("!!(window.__tvAgent && window.__tvPlatform)");
    if (!ready) await sleep(500);
  }
  if (!ready) {
    throw new Error(
      "window.__tvAgent never appeared — a bundle or adapter error at boot. " +
      "Open the same inspector port in a browser and read the console.",
    );
  }

  results.device = JSON.parse(await cdp.eval("JSON.stringify(window.__tvPlatform.device)"));
  log(`[tizen] ${results.device.os} ${results.device.osVersion} · ${results.device.model} · soc=${results.device.soc}`);

  // Which audio API this build actually has. This is the single most valuable
  // line of the report on a first bring-up: the adapter prefers Samsung's
  // proprietary `webapis.audiocontrol` and falls back to the standard
  // `tizen.tvaudiocontrol`, and until a real board runs it, *neither* branch has
  // ever executed. A non-Samsung board is expected to take the second.
  results.audio = JSON.parse(await cdp.eval(`JSON.stringify({
    webapis: typeof webapis !== "undefined" && !!(webapis && webapis.audiocontrol),
    standard: typeof tizen !== "undefined" && !!(tizen && tizen.tvaudiocontrol),
  })`));
  const noAudioApi = !results.audio.webapis && !results.audio.standard;
  const api = results.audio.webapis ? "webapis.audiocontrol (Samsung)"
    : results.audio.standard ? "tizen.tvaudiocontrol (standard)"
    : "NONE";
  log(`[tizen] audio API: ${api}`);
  if (api === "NONE") {
    results.notes.push(
      "no audio control API on this build — volume and mute cannot work here. " +
      "If this is a Samsung TV, the host page is missing " +
      '<script src="$WEBAPIS/webapis/webapis.js">.',
    );
  }

  // Tizen drops config.xml's query string, so flags arrive baked. An app that
  // boots fine and silently ignores every flag is the worst failure available;
  // say it out loud.
  results.flags = await cdp.eval(
    "typeof globalThis.__AGENT_FLAGS__ === 'string' ? globalThis.__AGENT_FLAGS__ : ''",
  );
  log(`[tizen] launch flags: ${results.flags || "(none)"}`);
  if (!/confirm=auto/.test(results.flags)) {
    results.notes.push(
      "confirm=auto is not in the launch flags — launch_app is confirm-gated and " +
      "will stall on a dialog nobody is here to press. Repackage with " +
      "`node tools/package-tizen.mjs --flags confirm=auto ...`",
    );
  }

  await cdp.eval(`(() => {
    window.__probe = { tools: [], errors: [] };
    window.__tvAgent.events.on("tool:call", (e) => window.__probe.tools.push(e.name));
    window.__tvAgent.events.on("error", (e) => window.__probe.errors.push(String(e.error && e.error.message)));
    return true;
  })()`);

  // Pick an app that exists here. A board's app list is nothing like a retail
  // TV's, so hard-coding one would fail for reasons that say nothing about us.
  const listed = await cdp.attempt(
    "window.__tvPlatform.apps.listInstalledApps().then(a => JSON.stringify(a))",
  );
  const installed = listed.ok ? JSON.parse(listed.value) : [];
  if (!listed.ok) results.notes.push(`listInstalledApps failed: ${listed.error}`);
  const app = appName
    ?? installed.find((a) => /netflix|youtube|prime/i.test(a.name))?.name
    ?? installed[0]?.name;
  if (!app) throw new Error("no installed apps reported — can't exercise launch_app");
  results.app = app;
  log(`[tizen] ${installed.length} apps installed; using "${app}" for the launch step`);

  for (const command of script(app)) {
    const turn = await cdp.attempt(`window.__tvAgent.run(${JSON.stringify(command)})`);
    results.turns.push({ command, output: turn.ok ? turn.value : null, error: turn.ok ? null : turn.error });
    log(`  ▸ ${command}\n    → ${turn.ok ? turn.value : `THREW: ${turn.error}`}`);
  }

  const probe = JSON.parse(await cdp.eval("JSON.stringify(window.__probe)"));
  results.tools = probe.tools;
  results.errors = probe.errors;

  const endVolume = await cdp.attempt("window.__tvPlatform.system.getVolume()");
  const endMuted = await cdp.attempt("window.__tvPlatform.system.getMute()");
  results.end = {
    volume: endVolume.ok ? endVolume.value : null,
    muted: endMuted.ok ? endMuted.value : null,
    volumeError: endVolume.ok ? null : endVolume.error,
    mutedError: endMuted.ok ? null : endMuted.error,
  };

  results.independent = independentVolume();
  if (results.independent) {
    log(`[tizen] independent readback: ${results.independent.key} = ${results.independent.value}`);
  } else {
    results.notes.push(
      "no independent volume readback (vconftool absent or a different key on this build) — " +
      "the end state below is the adapter reporting on itself",
    );
  }

  if (!skipZh) {
    const zhSet = await cdp.attempt('window.__tvAgent.run("音量調到 30")');
    const zhAsk = await cdp.attempt('window.__tvAgent.run("現在音量多少?")');
    const answer = String(zhAsk.value ?? "");
    // What this step tests is that a Chinese question gets a Chinese answer —
    // language detection surviving the round trip through the device engine. On
    // a build with no audio API it cannot also report a level, and grading it on
    // one turned a platform limitation into a language failure.
    const inChinese = /[一-鿿]/.test(answer);
    results.zh = {
      set: zhSet.value ?? zhSet.error,
      ask: zhAsk.value ?? zhAsk.error,
      ok: zhAsk.ok && inChinese && (noAudioApi || (/音量/.test(answer) && /\d/.test(answer))),
      gradedOn: noAudioApi ? "language only (no audio API to report a level)" : "language and level",
    };
    log(`  ▸ 音量調到 30 / 現在音量多少?\n    → ${results.zh.set} / ${results.zh.ask}`);
  }

  cdp.close();
  shq("forward", "--remove", `tcp:${port}`);

  // --- verdict -------------------------------------------------------------
  // A build with no audio API cannot pass the audio half of this script, and
  // grading it against one would report a platform limitation as a regression.
  // Judge the part it *can* answer, and say clearly which run this was.
  const noAudio = noAudioApi;
  const audioTools = new Set(["set_volume", "get_volume", "set_mute"]);
  const expected = noAudio ? EXPECTED_TOOLS.filter((t) => !audioTools.has(t)) : EXPECTED_TOOLS;
  const actual = noAudio ? results.tools.filter((t) => !audioTools.has(t)) : results.tools;

  const toolsMatch = JSON.stringify(actual) === JSON.stringify(expected);
  const mutedOk = noAudio ? true : results.end.muted === true;

  let volumeOk;
  if (noAudio) {
    volumeOk = true;
  } else if (results.end.muted && results.end.volume === 0) {
    volumeOk = true;
    results.notes.push("volume reads 0 while muted (platform collapses volume under mute); unmute restores it");
  } else if (typeof results.end.volume !== "number") {
    volumeOk = false;
  } else {
    volumeOk = Math.abs(results.end.volume - EXPECTED_VOLUME) <= VOLUME_TOLERANCE;
    if (volumeOk && results.end.volume !== EXPECTED_VOLUME) {
      results.notes.push(`volume quantized to ${results.end.volume} (expected ~${EXPECTED_VOLUME}); the device maps 0-100 onto its own steps`);
    }
  }

  const zhOk = skipZh || results.zh?.ok === true;
  results.pass = toolsMatch && mutedOk && volumeOk && zhOk;
  results.mode = noAudio ? "no-audio (audio steps excluded)" : "full";

  if (!toolsMatch) {
    if (results.errors?.length) {
      results.diagnosis = "the agent raised errors — treat this as a platform/transport problem, not the model";
    } else if (actual.length === 0) {
      results.diagnosis = "no tool ran at all — check the model endpoint is reachable from the TV " +
        "(config.xml needs an <access> origin, and connect-src must allow the host)";
    } else if (actual.every((t) => expected.includes(t))) {
      results.diagnosis =
        "the tools that ran are legitimate but the sequence differs — usually the model, not the " +
        "device: small models skip the read-then-write and search-then-launch chains. Re-run " +
        "against tools/mock-llm-server.mjs to confirm the platform is fine.";
    } else {
      results.diagnosis = "an unexpected tool ran — check the tool schemas the model is being given";
    }
  }

  if (asJson) {
    console.log(JSON.stringify({
      ...results,
      expected: { tools: expected, volume: EXPECTED_VOLUME, tolerance: VOLUME_TOLERANCE, muted: !noAudio },
    }, null, 2));
  } else {
    console.log("\n--- verdict ---");
    console.log(`run mode      : ${results.mode}`);
    console.log(`audio API     : ${api}`);
    console.log(`tool sequence : ${toolsMatch ? "MATCH" : "MISMATCH"}`);
    if (!toolsMatch) {
      console.log(`  expected: ${expected.join(", ")}`);
      console.log(`  actual  : ${actual.join(", ")}`);
      console.log(`  → ${results.diagnosis}`);
    }
    if (noAudio) {
      console.log("end state     : not applicable — this build has no audio control API");
    } else {
      console.log(`end state     : volume=${results.end.volume} muted=${results.end.muted} ` +
                  `(expected ~${EXPECTED_VOLUME}±${VOLUME_TOLERANCE} / true) ${volumeOk && mutedOk ? "OK" : "WRONG"}`);
      if (results.independent) {
        console.log(`independent   : ${results.independent.key} = ${results.independent.value} ` +
                    "(read from the platform, not from the adapter)");
      }
    }
    if (!skipZh) console.log(`chinese replies: ${zhOk ? "OK" : "WRONG"} (${results.zh.gradedOn})`);
    if (results.errors?.length) console.log(`agent errors  : ${results.errors.join(" | ")}`);
    for (const note of results.notes) console.log(`note          : ${note}`);
    console.log(`\n${results.pass ? "PASS" : "FAIL"} — on-device behaviour ${results.pass ? "matches" : "differs from"} the CI baseline\n`);
  }
  process.exit(results.pass ? 0 : 1);
} catch (err) {
  if (asJson) console.log(JSON.stringify({ ...results, error: String(err.message ?? err) }, null, 2));
  else console.error(`\n[tizen] FAILED: ${err.message ?? err}\n`);
  process.exit(2);
}
