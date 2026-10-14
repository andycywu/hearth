/**
 * The lab's one page. Plain HTML, CSS and JS in a string: it is served by a
 * 150-line HTTP server on the Pi itself, there is nothing to build and no
 * network asset to fetch, and a page that needs the internet to debug the
 * television's bus would be a poor tool.
 *
 * Everything that comes from a command's output is put on the page with
 * `textContent`, never as HTML — it is text from a device on the other end of a
 * cable.
 */
export const LAB_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hearth Lab</title>
<style>
  :root { --bg:#0f1318; --panel:#171d25; --line:#2a3340; --text:#e8edf3; --dim:#9aa7b6; --accent:#5aa9ff;
          --ok:#3ccf91; --warn:#f2b84b; --bad:#ff6b6b; --mono: ui-monospace, "DejaVu Sans Mono", Menlo, monospace; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f4f6f9; --panel:#ffffff; --line:#d5dbe3; --text:#16202b; --dim:#566474; --accent:#0b62d6; --ok:#0a7d52; --warn:#9a6700; --bad:#c62828; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.45 system-ui, sans-serif; }
  header { display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:5; }
  h1 { font-size:19px; margin:0 8px 0 0; }
  .chip { border:1px solid var(--line); border-radius:999px; padding:3px 11px; font-size:14px; color:var(--dim); }
  .chip b { color:var(--text); font-weight:600; }
  .chip.ok b { color:var(--ok); } .chip.warn b { color:var(--warn); } .chip.bad b { color:var(--bad); }
  button { font:inherit; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 13px; cursor:pointer; }
  button:hover { border-color:var(--accent); } button:disabled { opacity:.5; cursor:wait; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:600; }
  button.danger { border-color:var(--warn); }
  nav { display:flex; gap:6px; padding:10px 16px 0; } nav button { border-bottom-left-radius:0; border-bottom-right-radius:0; }
  nav button[aria-selected="true"] { background:var(--accent); color:#fff; border-color:var(--accent); }
  main { display:grid; grid-template-columns: minmax(330px, 42%) 1fr; gap:16px; padding:14px 16px 40px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  section.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:14px; }
  h2 { font-size:14px; letter-spacing:.04em; text-transform:uppercase; color:var(--dim); margin:0 0 8px; }
  .grid { display:flex; flex-wrap:wrap; gap:8px; }
  .grid button small { display:block; color:var(--dim); font-size:12px; }
  label { color:var(--dim); font-size:14px; } input, select { font:inherit; color:var(--text); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
  input.wide { width:100%; font-family:var(--mono); }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
  .card { background:var(--panel); border:1px solid var(--line); border-left-width:6px; border-radius:8px; padding:10px 12px; margin-bottom:10px; }
  .card.reply, .card.sent, .card.ok { border-left-color:var(--ok); } .card.no-reply, .card.warn, .card.feature-abort { border-left-color:var(--warn); }
  .card.not-acknowledged, .card.error, .card.unconfigured, .card.fail { border-left-color:var(--bad); }
  .card h3 { margin:0 0 4px; font-size:16px; display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
  .card h3 small { color:var(--dim); font-weight:400; }
  .verdict { font-family:var(--mono); font-size:13px; padding:1px 8px; border-radius:5px; border:1px solid currentColor; }
  .card.reply .verdict, .card.sent .verdict, .card.ok .verdict { color:var(--ok); }
  .card.no-reply .verdict, .card.warn .verdict, .card.feature-abort .verdict { color:var(--warn); }
  .card.not-acknowledged .verdict, .card.error .verdict, .card.unconfigured .verdict, .card.fail .verdict { color:var(--bad); }
  .facts { font-family:var(--mono); font-size:13px; color:var(--dim); margin:4px 0; }
  details { margin-top:6px; } summary { cursor:pointer; color:var(--dim); font-size:14px; }
  pre { font:12.5px/1.4 var(--mono); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px; overflow:auto; max-height:260px; margin:6px 0; white-space:pre-wrap; }
  .cmd { font-family:var(--mono); font-size:13px; color:var(--accent); word-break:break-all; }
  .muted { color:var(--dim); font-size:14px; } .layer { display:grid; grid-template-columns: 24px 150px 1fr; gap:8px; padding:5px 0; border-bottom:1px solid var(--line); }
  .layer:last-child { border-bottom:0; } .mark { font-weight:700; } .layer.ok .mark { color:var(--ok); } .layer.warn .mark { color:var(--warn); } .layer.fail .mark { color:var(--bad); } .layer.skipped .mark { color:var(--dim); }
  #monitor { height:200px; }
  .hidden { display:none; }
</style>
</head>
<body>
<header>
  <h1>Hearth Lab</h1>
  <span class="chip" id="chipAdapter">adapter <b>…</b></span>
  <span class="chip" id="chipLogical">logical address <b>…</b></span>
  <span class="chip" id="chipPower">power <b>…</b></span>
  <span class="chip" id="chipTv">TV <b>not asked yet</b></span>
  <span style="flex:1"></span>
  <button class="primary" id="btnDiagnose">Diagnose the CEC path</button>
  <button id="btnRefresh">Refresh</button>
</header>
<nav role="tablist">
  <button role="tab" aria-selected="true" data-tab="cec">CEC</button>
  <button role="tab" aria-selected="false" data-tab="audio">Audio</button>
  <button role="tab" aria-selected="false" data-tab="hearth">Hearth's view</button>
</nav>
<main>
  <div id="controls">
    <div data-pane="cec">
      <section class="panel">
        <h2>Target</h2>
        <div class="row"><label for="target">logical address</label>
          <select id="target"><option value="0" selected>0 — TV</option><option value="5">5 — Audio system</option><option value="3">3 — Tuner</option><option value="1">1 — Recording</option><option value="8">8 — Playback 2</option><option value="11">11 — Playback 3</option></select>
          <span class="muted">Commands marked ⚠ change the TV and ask first.</span></div>
      </section>
      <div id="groups"></div>
      <section class="panel">
        <h2>Raw cec-ctl</h2>
        <div class="muted">Flags and plain values only, as you would type them after <span class="cmd">cec-ctl -d /dev/cec0</span>.</div>
        <input class="wide" id="raw" placeholder="--to 0 --give-device-power-status" autocomplete="off" spellcheck="false">
        <div class="row"><button id="btnRaw">Send</button></div>
      </section>
      <section class="panel">
        <h2>Bus monitor</h2>
        <div class="muted">Every message on the bus, as it happens — including the ones the TV sends on its own.</div>
        <div class="row"><button id="btnMon">Start</button><button id="btnMonClear">Clear</button></div>
        <pre id="monitor"></pre>
      </section>
    </div>

    <div data-pane="audio" class="hidden">
      <section class="panel">
        <h2>Microphone</h2>
        <div class="muted">Record a few seconds and read its level. Compare a silent recording with one where you talk: speech should be tens of dB above the room.</div>
        <div class="row"><label for="secs">seconds</label><input id="secs" type="number" min="1" max="15" value="4" style="width:70px">
          <button id="btnRoom">Record the room (stay silent)</button><button id="btnVoice">Record me speaking</button></div>
        <div class="row"><button id="btnPlayHere">Play last recording here</button><button id="btnPlayTv">Play last recording through the speaker</button></div>
        <audio id="player" controls class="hidden" style="width:100%;margin-top:8px"></audio>
      </section>
      <section class="panel">
        <h2>Speaker</h2>
        <div class="row"><button data-say="Hearth audio test. One, two, three." data-voice="">Say it in English</button><button data-say="你好，這是音訊測試。" data-voice="cmn">說中文</button></div>
        <div class="muted" style="margin-top:6px">This is checked by ear: nothing reads it back.</div>
      </section>
    </div>

    <div data-pane="hearth" class="hidden">
      <section class="panel">
        <h2>What Hearth's own code sees</h2>
        <div class="muted">Runs Hearth's CEC transport (the code the agent uses) and shows its answer next to the raw bus. If the raw bus says the TV is there and this says no, the fault is in Hearth, not in the cable.</div>
        <div class="row"><button class="primary" id="btnHearth">Scan with Hearth's transport</button></div>
      </section>
    </div>
  </div>

  <div id="log"><div class="muted" id="empty">Nothing sent yet. Press <b>Diagnose the CEC path</b> to find the first layer that is not working.</div></div>
</main>

<script>
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("t") || "";
  var $ = function (id) { return document.getElementById(id); };
  var log = $("log"), state = null;

  function api(path, body) {
    var url = path + (path.indexOf("?") < 0 ? "?" : "&") + "t=" + encodeURIComponent(token);
    var opts = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    return fetch(url, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function put(card) { var empty = $("empty"); if (empty) empty.remove(); log.insertBefore(card, log.firstChild); }
  function busy(btn, on) { if (btn) btn.disabled = on; document.body.style.cursor = on ? "progress" : ""; }
  function chip(id, label, value, cls) { var c = $(id); c.className = "chip " + (cls || ""); c.textContent = ""; c.append(label + " "); c.append(el("b", "", value)); }

  var VERDICT = { "reply": "✓ reply", "sent": "→ sent", "no-reply": "… no reply", "not-acknowledged": "✗ not acknowledged", "feature-abort": "⊘ feature abort", "unconfigured": "! unconfigured", "error": "✗ error" };

  function stepsBlock(steps) {
    var d = el("details"); d.append(el("summary", "", "commands and raw output (" + steps.length + ")"));
    steps.forEach(function (s) {
      var line = el("div", "cmd", "$ " + s.cmdline); d.append(line);
      var copy = el("button", "", "copy"); copy.style.marginLeft = "8px"; copy.style.padding = "1px 8px";
      copy.onclick = function () { navigator.clipboard && navigator.clipboard.writeText(s.cmdline); copy.textContent = "copied"; };
      line.append(copy);
      d.append(el("div", "muted", "exit " + s.code + " · " + s.ms + " ms"));
      d.append(el("pre", "", s.out || "(no output)"));
    });
    return d;
  }

  function showResult(r) {
    var card = el("div", "card " + r.verdict);
    var h = el("h3"); h.append(el("span", "", r.label)); h.append(el("span", "verdict", VERDICT[r.verdict] || r.verdict));
    h.append(el("small", "", (r.target >= 0 ? "to " + r.target + " · " : "") + r.ms + " ms · " + new Date(r.at).toLocaleTimeString()));
    card.append(h); card.append(el("div", "", r.summary));
    var keys = Object.keys(r.facts || {});
    if (keys.length) card.append(el("div", "facts", keys.map(function (k) { return k + ": " + r.facts[k]; }).join("   ")));
    if (r.readBack) card.append(el("div", r.readBack.reached ? "facts" : "facts", "read-back: wanted " + r.readBack.wanted + ", last read " + (r.readBack.last || "no answer") + " after " + (r.readBack.afterMs / 1000).toFixed(1) + " s → " + (r.readBack.reached ? "VERIFIED" : "NOT verified")));
    if (r.steps && r.steps.length) card.append(stepsBlock(r.steps));
    put(card);
    if (r.facts && r.facts["pwr-state"]) chip("chipTv", "TV", r.facts["pwr-state"].split(" ")[0], /on/.test(r.facts["pwr-state"]) ? "ok" : "warn");
    if (r.verdict === "not-acknowledged") chip("chipTv", "TV", "not acknowledging", "bad");
  }

  function showDiagnosis(d) {
    var card = el("div", "card " + (d.firstProblem ? (d.firstProblem.status === "fail" ? "fail" : "warn") : "ok"));
    var h = el("h3"); h.append(el("span", "", "Diagnosis")); h.append(el("small", "", new Date().toLocaleTimeString())); card.append(h);
    card.append(el("div", "", d.firstProblem ? "First problem: " + d.firstProblem.layer + " — " + d.firstProblem.detail : "Every layer checked is working."));
    d.steps.forEach(function (s) {
      var row = el("div", "layer " + s.status);
      row.append(el("span", "mark", { ok: "✓", warn: "!", fail: "✗", skipped: "–" }[s.status]));
      row.append(el("b", "", s.layer));
      var t = el("div"); t.append(el("div", "", s.detail)); if (s.fix) t.append(el("div", "muted", "→ " + s.fix)); row.append(t);
      card.append(row);
    });
    put(card);
  }

  function showSimple(title, status, lines) {
    var card = el("div", "card " + status); var h = el("h3"); h.append(el("span", "", title)); h.append(el("small", "", new Date().toLocaleTimeString()));
    card.append(h); lines.forEach(function (l) { card.append(typeof l === "string" ? el("div", "", l) : l); }); put(card); return card;
  }

  function fail(e) { showSimple("Request failed", "error", [String(e && e.message || e)]); }

  function refresh() {
    return api("/api/state").then(function (s) {
      state = s;
      chip("chipAdapter", "adapter", s.device + " @ " + (s.adapter.physical || "?"), s.adapter.physical && s.adapter.physical !== "f.f.f.f" ? "ok" : "bad");
      chip("chipLogical", "logical address", s.adapter.logical.length ? s.adapter.logical.join(",") : "none (fresh boot)", s.adapter.logical.length ? "ok" : "warn");
      chip("chipPower", "power", s.throttled || "unknown", s.throttled === "0x0" ? "ok" : (s.throttled ? "warn" : ""));
      if (!$("groups").children.length) buildGroups(s.commands);
    }).catch(fail);
  }

  var GROUPS = { adapter: "This box's adapter", info: "Ask the TV (read-only)", power: "Power", source: "Input / source", keys: "Remote keys" };
  function buildGroups(commands) {
    Object.keys(GROUPS).forEach(function (g) {
      var list = commands.filter(function (c) { return c.group === g; }); if (!list.length) return;
      var sec = el("section", "panel"); sec.append(el("h2", "", GROUPS[g])); var grid = el("div", "grid");
      list.forEach(function (c) {
        var b = el("button", c.changesState ? "danger" : "", (c.changesState ? "⚠ " : "") + c.label); b.title = c.explain;
        b.onclick = function () {
          if (c.changesState && !confirm(c.label + "\\n\\n" + c.explain + "\\n\\nSend it?")) return;
          busy(b, true);
          api("/api/run", { id: c.id, target: Number($("target").value) }).then(showResult, fail).then(function () { busy(b, false); refresh(); });
        };
        grid.append(b);
      });
      sec.append(grid); $("groups").append(sec);
    });
  }

  $("btnDiagnose").onclick = function () { var b = this; busy(b, true); api("/api/diagnose", {}).then(showDiagnosis, fail).then(function () { busy(b, false); refresh(); }); };
  $("btnRefresh").onclick = refresh;
  $("btnRaw").onclick = function () {
    var text = $("raw").value.trim(); if (!text) return; var b = this; busy(b, true);
    api("/api/raw", { args: text.split(/\\s+/) }).then(showResult, fail).then(function () { busy(b, false); refresh(); });
  };
  $("raw").addEventListener("keydown", function (e) { if (e.key === "Enter") $("btnRaw").click(); });

  // monitor
  var es = null;
  $("btnMon").onclick = function () {
    if (es) { es.close(); es = null; this.textContent = "Start"; return; }
    var pre = $("monitor"); this.textContent = "Stop";
    es = new EventSource("/api/monitor?t=" + encodeURIComponent(token));
    es.onmessage = function (m) { pre.textContent += JSON.parse(m.data) + "\\n"; pre.scrollTop = pre.scrollHeight; };
    es.addEventListener("fault", function (m) { pre.textContent += "[monitor] " + JSON.parse(m.data) + "\\n"; });
    es.onerror = function () { pre.textContent += "[monitor] connection closed\\n"; if (es) { es.close(); es = null; $("btnMon").textContent = "Start"; } };
  };
  $("btnMonClear").onclick = function () { $("monitor").textContent = ""; };

  // audio
  function record(label, btn) {
    busy(btn, true);
    api("/api/audio/record", { seconds: Number($("secs").value) || 4 }).then(function (r) {
      var lines = [];
      if (r.ok) {
        lines.push("peak " + (r.levels.peakDb === null ? "silence" : r.levels.peakDb + " dB") + " · average " + (r.levels.rmsDb === null ? "silence" : r.levels.rmsDb + " dB") + " · " + r.levels.seconds + " s");
        lines.push("For reference: a quiet room averages about -45 dB here; speech at normal distance should average well above -35 dB.");
      } else lines.push(r.error);
      var c = el("div", "cmd", "$ " + r.cmdline); lines.push(c);
      showSimple(label, r.ok ? "ok" : "error", lines);
      if (r.ok) { var p = $("player"); p.classList.remove("hidden"); p.src = "/api/audio/last.wav?t=" + encodeURIComponent(token) + "&n=" + Date.now(); }
    }, fail).then(function () { busy(btn, false); });
  }
  $("btnRoom").onclick = function () { record("Microphone: the room", this); };
  $("btnVoice").onclick = function () { record("Microphone: you speaking", this); };
  $("btnPlayHere").onclick = function () { var p = $("player"); if (p.src) p.play(); else showSimple("Nothing recorded yet", "warn", ["Record something first."]); };
  $("btnPlayTv").onclick = function () { var b = this; busy(b, true); api("/api/audio/play", {}).then(function (r) { showSimple("Playback through the speaker", r.ok ? "ok" : "error", [r.ok ? "Played. Did you hear it? (nothing reads this back)" : r.error, el("div", "cmd", "$ " + r.cmdline)]); }, fail).then(function () { busy(b, false); }); };
  Array.prototype.forEach.call(document.querySelectorAll("[data-say]"), function (b) {
    b.onclick = function () { busy(b, true); api("/api/audio/say", { text: b.dataset.say, voice: b.dataset.voice }).then(function (r) { showSimple("Speaker", r.ok ? "ok" : "error", [r.ok ? "Spoken. Did you hear it from the TV? (nothing reads this back)" : r.error, el("div", "cmd", "$ " + r.cmdline)]); }, fail).then(function () { busy(b, false); }); };
  });

  // hearth's view
  $("btnHearth").onclick = function () {
    var b = this; busy(b, true);
    api("/api/hearth-view", {}).then(function (r) {
      var lines = [r.summary];
      (r.devices || []).forEach(function (d) { lines.push(el("div", "facts", d)); });
      showSimple("Hearth's own transport", r.ok ? "ok" : "fail", lines);
    }, fail).then(function () { busy(b, false); });
  };

  // tabs
  Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (x) { x.setAttribute("aria-selected", String(x === t)); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-pane]"), function (p) { p.classList.toggle("hidden", p.dataset.pane !== t.dataset.tab); });
    };
  });

  refresh();
})();
</script>
</body>
</html>
`;
