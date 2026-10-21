/*
 * What can a page on this television see of its inputs, and can it switch them?
 *
 * Every step records what it *got* — a value, or the error's name, message and code — never what it hoped. Reading steps run on
 * load. Switching does NOT: it is exposed as window.__probeSwitch(type, number) and is only called by run.mjs when asked, because it
 * changes what the television is showing. Plain ES5; the page may run on an old Chromium.
 */
(function () {
  'use strict';
  var probe = { startedAt: new Date().toISOString(), steps: [], done: false, lastSources: null };
  window.__probe = probe;

  function show() {
    var el = document.getElementById('out');
    if (el) el.textContent = JSON.stringify(probe.steps.map(function (s) { return s.name + ': ' + brief(s.value); }), null, 1);
  }
  function brief(v) { var t = JSON.stringify(v); return t && t.length > 90 ? t.slice(0, 90) + '…' : t; }
  function note(name, value) { probe.steps.push({ name: name, value: value }); show(); }
  function errInfo(e) {
    if (e === undefined || e === null) return String(e);
    if (typeof e === 'string') return e;
    return { name: e.name || e.type || typeof e, message: e.message, code: e.code };
  }
  function fnNames(o) {
    var r = [];
    try { for (var k in o) { if (typeof o[k] === 'function') r.push(k); } } catch (e) { /* host objects can throw on enumeration */ }
    return r.sort();
  }
  function keysOf(o) { var r = []; try { for (var k in o) r.push(k); } catch (e) { /* see above */ } return r.sort(); }
  function attempt(name, fn) {
    try { note(name, { ok: true, value: fn() }); } catch (e) { note(name, { ok: false, error: errInfo(e) }); }
  }
  /** A call that answers through callbacks. Waits at most 4 s: a missing answer is a result, not a hang. */
  function viaCallbacks(name, call, next) {
    var finished = false;
    var timer = setTimeout(function () { if (!finished) { finished = true; note(name, { ok: false, error: 'no answer in 4 s' }); next(); } }, 4000);
    function done(entry) { if (finished) return; finished = true; clearTimeout(timer); note(name, entry); next(); }
    try {
      call(function (v) { done({ ok: true, value: v }); }, function (e) { done({ ok: false, error: errInfo(e) }); });
    } catch (e) { done({ ok: false, threw: errInfo(e) }); }
  }

  var queue = [];
  function step(fn) { queue.push(fn); }
  function run() {
    var fn = queue.shift();
    if (!fn) { probe.done = true; show(); return; }
    fn(run);
  }

  // --- what globals exist
  step(function (next) {
    attempt('globals', function () {
      return {
        tizen: typeof tizen !== 'undefined', webapis: typeof webapis !== 'undefined',
        tizenTv: typeof tizen !== 'undefined' ? keysOf(tizen).filter(function (k) { return /^tv|systeminfo|application|time/.test(k); }) : [],
        webapisKeys: typeof webapis !== 'undefined' ? keysOf(webapis) : []
      };
    });
    attempt('productinfo', function () {
      var p = webapis.productinfo;
      return { model: p.getModel && p.getModel(), version: p.getVersion && p.getVersion(), firmware: p.getFirmware && p.getFirmware(), realModel: p.getRealModel && p.getRealModel() };
    });
    next();
  });

  // --- Samsung's webapis.tvinfo: what is there, and what its zero-argument getters answer
  step(function (next) {
    attempt('webapis.tvinfo', function () {
      var t = webapis.tvinfo;
      if (!t) return 'absent';
      var out = { functions: fnNames(t), getters: {} };
      var names = out.functions;
      for (var i = 0; i < names.length; i++) {
        if (/^get/.test(names[i]) && t[names[i]].length === 0) {
          try { out.getters[names[i]] = t[names[i]](); } catch (e) { out.getters[names[i]] = { threw: errInfo(e) }; }
        }
      }
      return out;
    });
    next();
  });

  step(function (next) {
    attempt('webapis.tvinfo: constants and getTvInfoValue', function () {
      var t = webapis.tvinfo, constants = {}, values = {};
      var ks = keysOf(t);
      for (var i = 0; i < ks.length; i++) {
        var v = t[ks[i]];
        if (typeof v === 'number' || typeof v === 'string') constants[ks[i]] = v;
      }
      for (var name in constants) {
        if (/INPUT|SOURCE|EXTERNAL|HDMI/i.test(name) && t.getTvInfoValue) {
          try { values[name] = t.getTvInfoValue(constants[name]); } catch (e) { values[name] = { threw: errInfo(e) }; }
        }
      }
      return { constantNames: Object.keys(constants), asked: values };
    });
    next();
  });

  // --- the standard Tizen TV window API
  step(function (next) {
    attempt('tizen.tvwindow', function () { return typeof tizen !== 'undefined' && tizen.tvwindow ? { functions: fnNames(tizen.tvwindow) } : 'absent'; });
    next();
  });
  step(function (next) {
    // Synchronous, window type first. (The first run of this probe called it as (ok, err, type) and was told it could not convert
    // a function to the enum it expected — which is how the signature was learned.)
    attempt('tvwindow.getSource("MAIN")', function () { return tizen.tvwindow.getSource('MAIN'); });
    attempt('tvwindow.getSource()', function () { return tizen.tvwindow.getSource(); });
    attempt('tvwindow.getRect("MAIN")', function () { return tizen.tvwindow.getRect('MAIN'); });
    next();
  });
  step(function (next) {
    if (typeof tizen === 'undefined' || !tizen.tvwindow || !tizen.tvwindow.getAvailableWindows) { note('tvwindow.getAvailableWindows', 'absent'); next(); return; }
    viaCallbacks('tvwindow.getAvailableWindows', function (ok, err) { tizen.tvwindow.getAvailableWindows(ok, err); }, next);
  });

  // --- which sources have something on them
  step(function (next) {
    viaCallbacks('systeminfo VIDEOSOURCE', function (ok, err) {
      tizen.systeminfo.getPropertyValue('VIDEOSOURCE', function (v) { probe.lastSources = v; ok(v); }, err);
    }, next);
  });

  // --- the app list shape (for `application.info` against `application.launch` alone)
  step(function (next) {
    viaCallbacks('application.getAppsInfo (count, first 3)', function (ok, err) {
      tizen.application.getAppsInfo(function (list) {
        var sample = [];
        for (var i = 0; i < list.length && i < 3; i++) sample.push({ id: list[i].id, name: list[i].name, show: list[i].show });
        ok({ count: list.length, sample: sample });
      }, err);
    }, next);
  });

  /**
   * Switch the television to one of the connected sources and report what happened.
   * Never called by the page itself. `done(result)` receives { ok, ... } with the timing.
   */
  window.__probeSwitch = function (type, number) {
    var started = new Date().getTime();
    // A source from either list: a port with nothing on it is still a port the television can be put on.
    var listed = probe.lastSources ? (probe.lastSources.connected || []).concat(probe.lastSources.disconnected || []) : [];
    var wanted = null;
    for (var i = 0; i < listed.length; i++) {
      if (listed[i].type === type && listed[i].number === number) wanted = listed[i];
    }
    var entry = { requested: { type: type, number: number }, found: !!wanted, before: null, after: null };
    try { entry.before = tizen.tvwindow.getSource(); } catch (e) { entry.before = { error: errInfo(e) }; }
    probe.switchResult = null;
    function finish() {
      // What the television says it is on now, read back rather than assumed.
      try { entry.after = tizen.tvwindow.getSource(); } catch (e) { entry.after = { error: errInfo(e) }; }
      entry.ms = new Date().getTime() - started; probe.switchResult = entry;
    }
    if (!wanted) { entry.error = 'that source is not in either list'; finish(); return; }
    try {
      tizen.tvwindow.setSource(wanted, function () {
        entry.ok = true; setTimeout(finish, 1500);        // give the television a moment to move before reading it back
      }, function (e) {
        entry.ok = false; entry.error = errInfo(e); finish();
      });   // three arguments, as free-my-tv calls it; the optional window type is left to default
    } catch (e) {
      entry.ok = false; entry.threw = errInfo(e); probe.switchResult = entry;
    }
  };

  setTimeout(run, 300);
})();
