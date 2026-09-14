/**
 * Driving a Tizen television from a workstation.
 *
 * Everything here was written for `device-acceptance-tizen.mjs` and is now
 * shared with `device-report-tizen.mjs`, because the second tool needed the same
 * six things the first one had already learned:
 *
 *   - where `sdb` is, on a machine that may have two complete Tizen SDKs
 *   - that the Web Inspector arrives via `app_launcher -w`, not `tz run -d`
 *   - that the app must be killed first, or you debug a stale page
 *   - which audio API this build actually has, which is the whole question
 *   - that launch flags are baked at package time and can be silently absent
 *   - that `vconftool`, when present, can answer about the volume without
 *     asking the code under test
 *
 * A second copy of that would have drifted from this one on the first bring-up
 * day, and the two tools would then disagree about the same television.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * `sdb`, from the same search `tools/tizen-sdk.mjs` does for `tz` — the VS Code
 * extension's SDK first, a legacy Tizen Studio install second, PATH last.
 *
 * Kept as its own list rather than importing that module's single answer: a
 * machine can have `sdb` on PATH and no `tz` at all (you can drive a television
 * without being able to build for it), and refusing to look would be unhelpful.
 */
export function findSdb() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [
    process.env.TIZEN_SDK && join(process.env.TIZEN_SDK, "tools", "sdb.exe"),
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

/**
 * An `sdb` bound to one device, as a pair of callers: `sh` throws on failure,
 * `shq` answers "" — some of what we ask for is informational and a given board
 * simply may not have it.
 */
export function sdbFor(sdb, serial = null) {
  const sh = (...argv) => {
    const full = serial ? ["-s", serial, ...argv] : argv;
    return execFileSync(sdb, full, { encoding: "utf8", maxBuffer: 8 << 20 }).trim();
  };
  const shq = (...argv) => {
    try { return sh(...argv); } catch { return ""; }
  };
  return { sh, shq };
}

/**
 * The attached devices, or a refusal that names the fix.
 *
 * Parsed by *rejecting* the lines that are not devices rather than by dropping
 * the first one. `sdb devices` prints its header on line one — except on the
 * first call after a reboot, when the daemon starts and announces itself:
 *
 *     * Server has started successfully *
 *     List of devices attached
 *
 * Skipping one line then left the header looking like an attached television.
 * The run continued with nothing connected and failed several steps later at
 * `app_launcher` with "error: target not found", which is a sentence about an
 * app id and sends you to check the app id. Running it a second time — daemon
 * already up — reported the truth, so the tool was wrong exactly once per boot,
 * which is exactly when someone is plugging a TV in for the first time.
 */
export function requireDevice({ shq }) {
  const lines = shq("devices")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("*"))                 // daemon banners
    .filter((l) => !/^List of devices/i.test(l));      // the header itself
  if (!lines.length) {
    throw new Error(
      "no device attached. Connect the television first:\n" +
      "  sdb connect <tv-ip>:26101         (or plug in USB)\n" +
      "  sdb devices                       (it must be listed)",
    );
  }
  // `offline` and `unauthorized` are listed just like a working device and then
  // fail every command, so say which one this is rather than proceeding.
  const usable = lines.filter((l) => /\bdevice\b/.test(l.split(/\s{2,}|\t/).slice(1).join(" ")));
  if (!usable.length) {
    throw new Error(
      `a device is listed but not usable:\n  ${lines.join("\n  ")}\n` +
      "Accept the connection on the TV, or reconnect: sdb disconnect && sdb connect <tv-ip>:26101",
    );
  }
  return usable;
}

/**
 * The `0 vd_applist` table, parsed.
 *
 * A television answers with one block of `--------key   =value-------` lines per
 * app, and the two ids in it are *both* needed and are not derivable from each
 * other:
 *
 *   app_id        tvaiagent0.tizen-app    ← what the `0` verbs take
 *   app_tizen_id  tvaiagent0.TvAiAgent    ← what config.xml declares
 *
 * The first is minted at install time from the project directory name, so
 * nothing in this repo can predict it; it has to be read back from the device.
 */
function parseVdAppList(out) {
  const apps = [];
  let current = {};
  for (const raw of out.split("\n")) {
    const m = /^-+([A-Za-z_0-9]+)\s*=(.*?)-+\s*$/.exec(raw.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (key === "app_id" && current.app_id) {
      apps.push(current);
      current = {};
    }
    current[key] = value.trim();
  }
  if (current.app_id) apps.push(current);
  return apps;
}

/** The `0`-verb id for a Tizen application id, or undefined on a board without them. */
export function resolveVdAppId({ shq }, appId) {
  const apps = parseVdAppList(shq("shell", "0", "vd_applist"));
  return apps.find((a) => a.app_tizen_id === appId)?.app_id;
}

/**
 * Start the app with the Web Inspector and return its port and how it got it.
 *
 * Killed first so the page is fresh, and therefore the agent is: a re-run
 * against a warm app inherits the previous run's conversation history, which
 * quietly changes what the model does on turn one.
 *
 * **Two launch paths, because a real television is not an emulator.** A retail
 * or licensed set reports `intershell_support:disabled` and answers *nothing at
 * all* to `sdb shell echo hello` — no output, no error, exit 0. Every command
 * this file used to run therefore succeeded silently and did nothing, which is
 * the exact failure this project exists to refuse, arriving in our own tooling.
 * What such a television does accept is a fixed vocabulary of `0 <verb>`
 * commands through its restricted shell:
 *
 *     0 vd_applist              the installed apps, with both of their ids
 *     0 was_kill <vd-app-id>    terminate ( `0 killapp` is accepted and does nothing )
 *     0 debug <vd-app-id>       launch with the inspector, printing its port
 *
 * So the VD path is tried first and `app_launcher` is the fallback, rather than
 * the other way round: the emulator is the special case, not the television.
 * Verified 2026-09-14 on an HKC-built Tizen 7.0 set, where `app_launcher -w`
 * returns an empty string and `0 debug` returns
 * `... successfully launched pid = 731 with debug 1 port: 38573`.
 */
export function launchWithInspector(sdb, appId) {
  const { shq } = sdb;
  const vdAppId = resolveVdAppId(sdb, appId);
  if (vdAppId) {
    shq("shell", "0", "was_kill", vdAppId);
    const out = shq("shell", "0", "debug", vdAppId);
    const port = /port:\s*(\d+)/.exec(out)?.[1];
    if (port) return { port: Number(port), via: `0 debug ${vdAppId}` };
  }

  // A board or emulator with a real shell.
  shq("shell", "app_launcher", "-k", appId);
  const out = shq("shell", "app_launcher", "-w", "-s", appId);
  const port = /port:\s*(\d+)/.exec(out)?.[1];
  if (port) return { port: Number(port), via: `app_launcher -w -s ${appId}` };

  throw new Error(
    `could not start ${appId} with the Web Inspector.\n` +
    (vdAppId
      ? `  \`0 debug ${vdAppId}\` printed no port, and app_launcher answered nothing either.`
      : "  This app is not in `0 vd_applist`, so it may not be installed — and\n" +
        "  `app_launcher -w` printed no port. On a television that answers nothing\n" +
        "  at all, check `sdb capability` for intershell_support:disabled.") + "\n" +
    `  Installed apps and their ids: sdb shell 0 vd_applist`,
  );
}

/** Forward the inspector to the same port locally, replacing any stale rule. */
export function forwardInspector({ sh, shq }, port) {
  shq("forward", "--remove", `tcp:${port}`);   // usually nothing to remove; sdb says so loudly
  sh("forward", `tcp:${port}`, `tcp:${port}`);
}

export function unforward({ shq }, port) {
  shq("forward", "--remove", `tcp:${port}`);
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
export function independentVolume({ shq }) {
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

/** Minimal CDP client over Node's built-in WebSocket. No dependencies. */
export class Cdp {
  #ws; #next = 1; #pending = new Map();
  consoleLines = [];

  /**
   * How long one evaluation may take before it is called a failure.
   *
   * There has to be a limit, because a television can stop answering without
   * closing the socket. Launching another app suspends the agent's page and its
   * JavaScript simply stops running mid-call: the request is delivered, nothing
   * rejects, nothing closes, and the promise never settles. Node then exits with
   * `Detected unsettled top-level await` and no explanation — which is what the
   * acceptance runner did on an HKC Tizen 7.0 set at the `launch_app` step
   * (2026-09-14), after the three audio steps before it had passed.
   *
   * Generous, because a real model on modest silicon can genuinely take most of
   * a minute for one turn, and calling that a hang would be its own wrong answer.
   */
  timeoutMs = 60_000;

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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(
          `${method} got no answer in ${this.timeoutMs} ms. The page is still connected but ` +
          "its JavaScript is not running — on a television this is what launching another app " +
          "looks like: the agent's page is suspended, and it will not answer again until it is " +
          "in the foreground.",
        ));
      }, this.timeoutMs);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    });
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function findPageTarget(port) {
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

/** Poll until an expression is true, so a slow television isn't a failure. */
export async function waitFor(cdp, expression, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    if (await cdp.eval(expression)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Which audio API this build actually has.
 *
 * On a first bring-up this is the single most valuable line of any report. The
 * adapter prefers Samsung's proprietary `webapis.audiocontrol` and falls back to
 * the standard `tizen.tvaudiocontrol`, and as of 2026-09 *neither branch has
 * ever executed* — the only Tizen image this project has run on has neither
 * global. A non-Samsung board is expected to take the second.
 */
export async function readAudioApi(cdp) {
  const found = JSON.parse(await cdp.eval(`JSON.stringify({
    webapis: typeof webapis !== "undefined" && !!(webapis && webapis.audiocontrol),
    standard: typeof tizen !== "undefined" && !!(tizen && tizen.tvaudiocontrol),
  })`));
  const name = found.webapis ? "webapis.audiocontrol (Samsung)"
    : found.standard ? "tizen.tvaudiocontrol (standard)"
    : "NONE";
  return { ...found, name, none: !found.webapis && !found.standard };
}

/** The message to print when a build has no audio API at all. */
export const NO_AUDIO_NOTE =
  "no audio control API on this build — volume and mute cannot work here. " +
  "If this is a Samsung TV, the host page is missing " +
  '<script src="$WEBAPIS/webapis/webapis.js">.';

/**
 * The launch flags the installed package was built with.
 *
 * Tizen's web runtime drops the query string from config.xml's `<content src>`,
 * so there is no launch-time equivalent of Android's `-e start`: flags are baked
 * in at package time and arrive as `__AGENT_FLAGS__`. An app that boots
 * perfectly and silently ignores every flag is the worst failure available on
 * this platform, so both tools read them back and say so.
 */
export async function readFlags(cdp) {
  return await cdp.eval(
    "typeof globalThis.__AGENT_FLAGS__ === 'string' ? globalThis.__AGENT_FLAGS__ : ''",
  );
}
