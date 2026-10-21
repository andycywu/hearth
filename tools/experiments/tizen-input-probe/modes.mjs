#!/usr/bin/env node
/**
 * Experiment 3: can one app be both a full-screen picture and a picture-with-a-panel, and move between them?
 *
 *   node tools/experiments/tizen-input-probe/modes.mjs [--stage 8]
 *
 * Experiment 2 found that `tvwindow.show` places the video window *above* the page, so at full screen the agent is unseen and with a
 * partial rectangle the page shows around the picture. The product wants both (full screen when someone is watching, a panel when
 * the agent has something to show) and a way back. This walks one page through five stages on the same source, announcing each in
 * the page's own text, so a person watching can say which of them worked:
 *
 *   1  full screen        picture only (the page is above nothing; its text is covered)
 *   2  panel              picture top-left at 70 %, the page's text visible in the remaining L-shaped margin
 *   3  full screen again  picture only — does a second `show` with a new rectangle move the window?
 *   4  hide               the page alone — does `hide` bring Hearth back?
 *   5  panel again        picture returns after a hide
 *
 * Stage numbers are printed with the time they begin. The original source is restored at the end.
 */
import { Cdp, findPageTarget, findSdb, forwardInspector, launchWithInspector, requireDevice, sdbFor, sleep, unforward, waitFor } from "../../tizen-device.mjs";

const args = process.argv.slice(2);
const stageMs = Number(args[args.indexOf("--stage") + 1] || 8) * 1000;
const sdb = sdbFor(findSdb());
requireDevice(sdb);
const launched = launchWithInspector(sdb, "tvprobe000.InputProbe");
forwardInspector(sdb, launched.port);
const cdp = await Cdp.connect((await findPageTarget(launched.port)).webSocketDebuggerUrl);
cdp.timeoutMs = 20_000;
await waitFor(cdp, "!!(window.__probe && window.__probe.done)", 60);
const ev = async (expr) => { try { return await cdp.eval(expr); } catch (e) { return `ERR ${e.message}`; } };

const original = JSON.parse(await ev("JSON.stringify(tizen.tvwindow.getSource('MAIN'))"));
await ev("window.__probeSwitch('HDMI', 1); 0");
await sleep(3500);
console.log("[modes] on HDMI 1 (was", JSON.stringify(original) + ")");

await ev(`document.documentElement.style.background = '#102040'; document.body.style.background = '#102040';
  var d = document.createElement('div'); d.id = 'stage';
  d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:324px;font:56px sans-serif;color:#fff;padding:40px;box-sizing:border-box';
  document.body.appendChild(d); 0`);
const say = (t) => ev(`document.getElementById('stage').textContent = ${JSON.stringify(t)}; 0`);
const show = (rect) => ev(`tizen.tvwindow.show(function(){ window.__s = 'ok'; }, function(e){ window.__s = e.name; }, ${JSON.stringify(rect)}, 'MAIN'); 0`);
const hide = () => ev(`tizen.tvwindow.hide(function(){ window.__s = 'ok'; }, function(e){ window.__s = e.name; }, 'MAIN'); 0`);

const stages = [
  ["1 full screen", async () => { await say("1: FULL SCREEN (you should see only the picture)"); await show(["0", "0", "1920", "1080"]); }],
  ["2 panel", async () => { await say("2: PANEL — Hearth is here, below the picture"); await show(["0", "0", "1440", "756"]); }],
  ["3 full screen again", async () => { await say("3: FULL SCREEN AGAIN"); await show(["0", "0", "1920", "1080"]); }],
  ["4 hide", async () => { await say("4: HIDDEN — the picture is gone, Hearth alone"); await hide(); }],
  ["5 panel again", async () => { await say("5: PANEL AGAIN — the picture should be back"); await show(["0", "0", "1440", "756"]); }],
];
for (const [name, go] of stages) {
  await go();
  const answer = await ev("window.__s"); await ev("window.__s = null; 0");
  console.log(`[modes] ${new Date().toLocaleTimeString()}  stage ${name}   (television said: ${answer})`);
  await sleep(stageMs);
}
console.log("[modes] page answering at the end:", await ev("document.getElementById('stage').textContent.slice(0, 20)"));
await hide();
await ev(`window.__probeSwitch(${JSON.stringify(original.type)}, ${Number(original.number)}); 0`);
await sleep(3500);
console.log("[modes] source now:", await ev("JSON.stringify(tizen.tvwindow.getSource('MAIN'))"));
try { cdp.close(); } catch { /* gone */ }
unforward(sdb, launched.port);
