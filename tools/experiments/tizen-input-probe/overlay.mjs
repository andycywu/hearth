#!/usr/bin/env node
/**
 * Experiment 2: can the page stay in front while the picture is behind it?
 *
 *   node tools/experiments/tizen-input-probe/overlay.mjs [--hold 20]
 *
 * Experiment 1 found that setSource only becomes visible once the television's own viewer is in front, and that launching it
 * suspends the page — so after an input switch the agent is gone until somebody finds it in the app list. Samsung's own PIP
 * features suggest another way: `tizen.tvwindow.show` places the MAIN video window in a rectangle, and a page with a transparent
 * background drawn over it would show the picture without leaving. This tries it: switch to HDMI 1, show the window in a
 * rectangle (half the screen), and keep the page's own text on top. Nothing is inferred; every answer the television gives
 * is printed, and the person watching says what they saw. Restores the original source at the end.
 *
 * Needs the probe installed (run.mjs without --no-install, once).
 */
import { findSdb, forwardInspector, launchWithInspector, requireDevice, sdbFor, Cdp, findPageTarget, waitFor, sleep, unforward } from "../../tizen-device.mjs";

const args = process.argv.slice(2);
const holdMs = Number(args[args.indexOf("--hold") + 1] || 20) * 1000;
const rectArg = args.includes("--rect") ? args[args.indexOf("--rect") + 1] : "960,270,960,540";
const appId = "tvprobe000.InputProbe";

const sdb = sdbFor(findSdb());
requireDevice(sdb);
const launched = launchWithInspector(sdb, appId);
forwardInspector(sdb, launched.port);
const cdp = await Cdp.connect((await findPageTarget(launched.port)).webSocketDebuggerUrl);
cdp.timeoutMs = 20_000;
await waitFor(cdp, "!!(window.__probe && window.__probe.done)", 60);

const ev = async (expr) => { try { return await cdp.eval(expr); } catch (e) { return `ERR ${e.message}`; } };
const original = JSON.parse(await ev("JSON.stringify(tizen.tvwindow.getSource('MAIN'))"));
console.log("[overlay] original source:", JSON.stringify(original));

// Await a callback-style API from the page and read the result back out.
const call = async (label, body) => {
  await ev(`window.__ov = null; (function(){ try { ${body} } catch (e) { window.__ov = { threw: e.name + ': ' + e.message }; } })(); 0`);
  for (let i = 0; i < 20; i++) {
    const r = await ev("JSON.stringify(window.__ov)");
    if (r && r !== "null") { console.log(`[overlay] ${label}: ${r}`); return r; }
    await sleep(300);
  }
  console.log(`[overlay] ${label}: no answer`);
  return null;
};

await call("switch to HDMI 1", `window.__probeSwitch('HDMI', 1); setTimeout(function(){ window.__ov = window.__probe.switchResult || {note:'no result'}; }, 3000);`);
await sleep(3500);

// Signatures are the television's to say: try the documented shape, then the others, and print what each does.
const rect = JSON.stringify(rectArg.split(","));
await call("show(ok, err, rect, 'MAIN')", `tizen.tvwindow.show(function(r){ window.__ov = { ok: r }; }, function(e){ window.__ov = { err: e.name + ': ' + e.message }; }, ${rect}, 'MAIN');`);
await call("getRect after show", `tizen.tvwindow.getRect(function(r){ window.__ov = { rect: r }; }, function(e){ window.__ov = { err: e.name + ': ' + e.message }; }, 'MAIN');`);

// The page's own content, on top, over a transparent background.
await ev(`document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent';
  var d = document.createElement('div'); d.id = 'ovl';
  d.style.cssText = 'position:fixed;left:40px;top:40px;font:48px sans-serif;color:#fff;background:rgba(0,0,0,0.6);padding:24px';
  d.textContent = 'Hearth is still here (rect ' + ${JSON.stringify(rectArg)} + ')'; document.body.appendChild(d); 0`);

console.log(`[overlay] >>> WATCH: the page text on top, and HDMI 1 in the rectangle ${rectArg}, for ${holdMs / 1000} s`);
const alive = [];
for (let i = 0; i < 4; i++) { await sleep(holdMs / 4); alive.push(await ev("document.getElementById('ovl') ? 'page still answering' : 'gone'")); }
console.log("[overlay] page during the hold:", alive.join(" | "));

await call("hide", `tizen.tvwindow.hide(function(){ window.__ov = { ok: true }; }, function(e){ window.__ov = { err: e.name + ': ' + e.message }; }, 'MAIN');`);
await call(`restore ${original.type} ${original.number}`, `window.__probeSwitch(${JSON.stringify(original.type)}, ${Number(original.number)}); setTimeout(function(){ window.__ov = window.__probe.switchResult || {note:'no result'}; }, 3000);`);
console.log("[overlay] source now:", await ev("JSON.stringify(tizen.tvwindow.getSource('MAIN'))"));
try { cdp.close(); } catch { /* gone */ }
unforward(sdb, launched.port);
