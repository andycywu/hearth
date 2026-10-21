#!/usr/bin/env node
/**
 * Launch the installed Hearth app under the Web Inspector and print what its page looks like and what the diagnostics said —
 * used to find out *why* a picture placed behind the page hid the page (is the video window above it, or is something opaque?).
 *
 *   node tools/experiments/tizen-input-probe/inspect-app.mjs
 *
 * Changes nothing but what launching the app already does (with `?diag&writes&input=…` baked in, that includes the input switch).
 */
import { Cdp, findPageTarget, findSdb, forwardInspector, launchWithInspector, requireDevice, sdbFor, sleep, unforward } from "../../tizen-device.mjs";

const sdb = sdbFor(findSdb());
requireDevice(sdb);
const launched = launchWithInspector(sdb, "tvaiagent0.TvAiAgent");
forwardInspector(sdb, launched.port);
const cdp = await Cdp.connect((await findPageTarget(launched.port)).webSocketDebuggerUrl);
cdp.timeoutMs = 20_000;
await sleep(6000);   // let the diagnostics run and the switch happen

const expr = `JSON.stringify((function () {
  var cs = function (el) { var c = getComputedStyle(el); return { display: c.display, background: c.backgroundColor + ' ' + c.backgroundImage.slice(0, 50), position: c.position, z: c.zIndex, opacity: c.opacity }; };
  var backdrop = document.getElementById('tv-backdrop');
  var rows = [].slice.call(document.querySelectorAll('body *')).filter(function (e) { return /setInputSource/.test(e.textContent || '') && e.children.length === 0; }).map(function (e) { return e.textContent; });
  var top = document.elementFromPoint(960, 540);
  return {
    source: (function () { try { return tizen.tvwindow.getSource('MAIN'); } catch (e) { return String(e); } })(),
    html: cs(document.documentElement), body: cs(document.body),
    backdrop: backdrop ? cs(backdrop) : null,
    elementAtCentre: top ? { tag: top.tagName, id: top.id, cls: top.className, style: cs(top) } : null,
    bodyChildren: [].slice.call(document.body.children).map(function (e) { return e.tagName + '#' + e.id + '.' + e.className; }),
    setInputSourceRows: rows,
    textStart: document.body.innerText.slice(0, 400),
  };
})())`;
console.log(JSON.stringify(JSON.parse(await cdp.eval(expr)), null, 1));
try { cdp.close(); } catch { /* gone */ }
unforward(sdb, launched.port);
