# What `free-my-tv` knows that our webOS and Tizen adapters do not

_Written 2026-10-21. A reading note, not a verification: nothing below has been run on a television by us._

[`simbasjungles/free-my-tv`](https://github.com/simbasjungles/free-my-tv) is an MIT-licensed replacement home screen for Google TV, LG
(webOS) and Samsung (Tizen), built with Claude Code and in daily use by its author. It is not a voice agent and has nothing to do
with what Hearth is *for*. It is useful to us for one narrow reason: to be a home screen it has to list the TV's apps, open them,
and switch and read inputs on **real LG and Samsung sets**, and that is exactly where our own adapters are stubs. Its calls are a
second source for what the platforms expose, written by someone who had a set in front of them.

**What was read:** the README, `web/tv.js` (the TV-facing layer for LG and Samsung), `tizen/config.xml` and `webos/appinfo.json`.
**Not read:** `web/home.js`, `webos/install.py`, `tizen/build.py`, the Android `Adb.java`. **Not run:** anything. Its performance claims
(60 fps, 96 MB) are the author's, on a 98" TCL. MIT is compatible with our Apache-2.0; we have copied nothing, and a copy would need
its notice kept.

## The finding that matters first: two of our own claims were never tested

Reading `web/tv.js` against `packages/adapter-tizen/src/index.ts` showed that **our Tizen adapter never asks the television to
switch input.** `setInputSource` is a hard-coded `throw new TvUnsupportedError(...)`; no API is called. And `getInputSource` is
`mapTizenSource(_raw) => "tv"` — it ignores what the TV said and answers `tv` always. Yet:

- [`capability-matrix.md`](capability-matrix.md) files Tizen+NVT input source as `⛔` — *the device refuses it* — and says "this build
  refuses `setInputSource` outright". The build was never asked. The honest cell is `❔` (untested). **Corrected there today.**
- The HKC report's `system.getInputSource ✅ tv` is the constant, not a reading.
- [`capability-graph.md`](../capability-graph.md) (lines ~114–125) and the `vouchesFor` comment in `core/src/capabilities/types.ts` say that on
  Tizen "the read works and the write is signing-gated forever". The read is a constant; the write was never tried; "forever" was not
  measured. Those two still need rewording; they are not changed here because one is a code comment.

`free-my-tv` calls `tizen.tvwindow.setSource(...)` and `tizen.systeminfo.getPropertyValue('VIDEOSOURCE')`, and declares the privileges
`http://tizen.org/privilege/tv.window` and `…/tv.inputdevice`. Our `config.xml` does not declare `tv.window`, and `tvwindow` appears
nowhere in this repository. Whether it works on a given set, and with what signing, is open: it is the first experiment below.

## Experiment 1, run 2026-10-21 on the HKC TTQ55UQ1CS (Tizen 7.0): the claim was wrong

[`tools/experiments/tizen-input-probe/`](../../tools/experiments/tizen-input-probe) — a throwaway page, built with the **`tizen-dev` certificate (not a partner
certificate)**, declaring `tv.window`, `tv.inputdevice`, `application.launch` and `application.info`. It installed without complaint and ran. Results in
`results/`. What the television *answered*:

| Call | Answer |
|---|---|
| `tizen.tvwindow.getSource()` | **`{type: "HDMI", number: 3}`** — the television's own report of what it is showing |
| `tizen.tvwindow.setSource(HDMI 3)`, then `(HDMI 1)`, then `(HDMI 3)` | **all three succeeded** (`ok: true`, ~1.5 s each) and each was read back with `getSource()`: 3 → 3, 3 → 1, 1 → 3. The probe put the set back on HDMI 3 itself |
| `tizen.systeminfo VIDEOSOURCE` | `connected: [TV 1]`, `disconnected: [AV 1, HDMI 1, HDMI 2, HDMI 3]` — which ports have a signal. **Not yet checked against a device plugged in**, so "connected" is unconfirmed |
| `tizen.tvwindow.getAvailableWindows()` | `["MAIN"]` |
| `webapis.tvinfo` | present, but its functions are `getMenuValue`, `getTvInfoValue`, `getVersion`, `setMenuValue`, caption helpers… — **there is no `getCurrentSource`**, the call our adapter makes. It has no constants to ask `getTvInfoValue` about |
| `webapis.productinfo` | **`SecurityError: Permission denied`** with these privileges — our adapter reads the model from it |
| `tizen.application.getAppsInfo` | 280 apps, with `application.info` declared |
| `tvwindow.getRect("MAIN")` | `TypeMismatchError` — the signature takes a callback first; not pursued |

**Then somebody looked at the screen, and the read-back turned out not to be enough.** The first switch ended with the television reporting
HDMI 1 and the owner seeing only the probe's own page: `setSource` moves the television's MAIN video window, and the probe is an
application drawn *over* it. Nothing on screen changed until the television's own viewer (`org.tizen.tv-viewer`, launched with
`tizen.application.launch` — which is what `free-my-tv` does after `setSource`) was brought to the front. Run that way, from HDMI 1 to HDMI 3 (a
port with nothing on it), the owner watched the picture go to a **no-signal screen** for the 15 seconds the probe held it, and back to the probe's page
when it was relaunched. So `setSource` + the viewer **visibly switches the television**, and a `setSource` that reports `ok` with the viewer
not shown is a switch nobody can see — the "read back" that was never the same thing as "happened". (The 12-second run from HDMI 1 to HDMI 1 was
not observed either way: the owner was not sure what was on screen. Switching *to* a port with a signal, and seeing that device's picture, is not yet
observed.) `VIDEOSOURCE` was checked against the owner: with a device plugged into HDMI 1 it listed HDMI 1 as connected where it had listed it
disconnected before.

One consequence for any adapter that runs *inside* the television: bringing the viewer to the front **suspends the page** (the Web Inspector
stops answering until it is relaunched — see `tools/tizen-device.mjs`). Verification has to happen before the viewer is launched, and the agent has to
expect to be suspended, as it is when it launches any other app.

So: **a page signed with an ordinary developer certificate can read and switch the input on this set.** The `⛔` and the "signing-gated forever"
were wrong, and so was reading the source through `tvinfo.getCurrentSource`, which does not exist here. Two caveats that keep this from being the
last word. The read-back is the television's own report through the same API family that did the switching; the *picture* changing has to be seen
(a person at the set, or a capture) before this is called independently confirmed. And it is one set, signed one way: a Samsung-branded set, or
the Samsung certificate profile, may answer differently — the probe takes `--profile` for exactly that.

## webOS (LG): their calls, ours

| What | `free-my-tv` | Our `adapter-webos` | Gap |
|---|---|---|---|
| List apps | `luna://com.webos.applicationManager/listLaunchPoints` → `id`, `title`, `largeIcon`/`icon`, `bgColor`/`iconColor`; hides `com.webos.app.{livetv,hdmiN,home,homeconnect,discovery,launcher,inputpicker}` | `…/listApps` → `id`, `title`, `version` | Different call. `listLaunchPoints` is what the launcher shows, with icons; `listApps` is what is installed. Ours is **unverified on any real LG** (the webOS 26 simulator has no apps to list) |
| Launch an app | `…/launch {id, params?}` | `…/launch {id}` | None — the same call |
| **Switch input** | **`launch` with `id: com.webos.app.hdmi1`…`hdmi4`, `com.webos.app.livetv`** — an input is an app | `setInputSource` → `notSupported("partner API")` | **We refuse a thing their author does with the call we already use.** Unverified for us; a candidate for `tv.input.switch` on LG |
| **Read the current input** | not used | `getInputSource` → constant `"app"` | `getForegroundAppInfo` (which we already call for the foreground app) should answer `com.webos.app.hdmiN` when an input is showing: a way to read it. Unverified |
| **Which ports have a device, and what the owner named it** | **`luna://com.webos.service.eim/getAllInputStatus`** → `devices[{appId, connected, label}]`; uses a user-given `label` such as "PS5" | nothing | **A Device Graph source for LG with no CEC bus**: "the PS5 is on HDMI 2" read from the TV. Unverified |
| Volume, mute | not used | `com.webos.audio/{getVolume,setVolume,setMuted}` | Nothing here confirms ours. Still unverified on a real set |
| Settings | `launch com.palm.app.settings` | — | trivial |
| Back key | `PalmSystem.platformBack()`; key code 461 | key code 461 | Agrees |
| Permissions in `appinfo.json` | `requiredPermissions: ["applications", "applications.launcher"]` | `["audio.operation", "settings.read", "read.app.info", "manage.app", "internet"]` | **Ours are different names. If either list is wrong, the Luna calls fail at runtime.** Theirs are reported working on a real set; ours have never met one |
| Install | builds the `.ipk` with a Python script (no LG CLI), installs through **Developer Mode** (Key Server + passphrase) over SSH; Dev Mode lapses after ~40 days unless **EXTEND** is pressed | `ares-package` + `ares-install` (`@webos-tools/cli`) | An alternative route with fewer prerequisites |

## Tizen (Samsung): their calls, ours

| What | `free-my-tv` | Our `adapter-tizen` | Gap |
|---|---|---|---|
| List apps | `tizen.application.getAppsInfo` → `id`, `name`, `show`, `iconPath`; skips `show === false` and a list of platform pieces (`org.volt.*`, `org.tizen.*` except browser/netflix, services, daemons, keyboards, ad players) | `getAppsInfo` → `id`, `name`, `version` | Same API. They filter what Smart Hub would not show and keep the icon |
| Launch an app | `tizen.application.launch(id)` | same | None |
| **Which sources are connected** | **`tizen.systeminfo.getPropertyValue('VIDEOSOURCE')`** → `connected: [{type: 'TV'\|'HDMI', number}]` | nothing | **Another Device Graph source**: which HDMI ports have something on them. Unverified on the HKC |
| **Switch source** | **`tizen.tvwindow.setSource(source, ok, err)`**, then launches `org.tizen.tv-viewer` so the source is shown | hard-coded refusal; **never called** | See above. Privilege `tv.window` is not in our `config.xml` |
| Read the current source | not used | `webapis.tvinfo.getCurrentSource` — absent on the TV 10.0 emulator, but **the HKC carries `tvinfo`** (capability matrix) — and then the answer is **thrown away**: `mapTizenSource` returns `"tv"` whatever it said | We may be discarding a real reading on the one set we have. Call it, log what it returns, and only then decide between it and `systeminfo VIDEOSOURCE` |
| Settings | `ApplicationControl('http://tizen.org/appcontrol/operation/setting')` | — | trivial |
| Time zone | `tizen.time.getLocalTimezone()` | — | trivial |
| Back key | 10009 | 10009 | Agrees |
| Privileges | `internet`, `developer.samsung.com/privilege/network.public`, `application.launch`, `tv.inputdevice`, **`tv.window`** (no `application.info`) | `application.launch`, `application.info`, `tv.audio`, `internet`, `tv.inputdevice` | Theirs lacks `application.info` yet calls `getAppsInfo`; ours has it. Which a given set requires is unverified. `tv.window` and `network.public` are theirs only |
| Install | **TizenBrew Installer** (a community tool) pulls the app from GitHub and, on 2023+ sets, signs it with the user's own Samsung account | `tizen` CLI with a `tizen-dev` certificate (works on the HKC) | A route for a retail Samsung set with no partner certificate. It is a third-party installer: weigh that before relying on it |

## Where our baseline leaves older televisions out

`free-my-tv` is **plain ES5**, "written for the Chromium of older TVs" — webOS 3 and 4, Tizen 3 — and hand-rolled with no framework.
Our bundles are built with `target: ["es2020"]` (`tools/bundle.mjs`), which assumes a Chromium from roughly 2020 on. `esbuild` does
not lower to ES5, so a build for the 2016–2019 sets is a different piece of work, not a flag. Worth knowing before anyone says the
runtime "installs on any TV": it installs on the ones whose browser engine can parse it, and the README's "four-year-old browser engine"
is a claim about that edge, not about 2016.

## Android TV: the idea, with the caveats

On Android it runs `pm disable-user`, `settings put secure …` and `cmd package set-home-activity` **through the TV's own ADB, over
`127.0.0.1:5555`**, after the user accepts the "Allow USB debugging?" prompt once for the app's own key. If that works generally, an
ordinary app obtains shell-user powers without a platform signature — which is the wall we hit on AOSP for input switching (platform
signature) and power. Things a shell user can do on Android TV that we have not tried (**all unverified**): `input keyevent` with the HDMI
input key codes, sleep/wake keys, and the `cmd hdmi_control` service shell commands. Two cautions: it needs Developer options and a
debugging prompt, which is a development-hub setup and not a stranger's television; and `free-my-tv` uses it to *disable system apps*,
which is not something Hearth should do.

## What not to take from it

- **Replacing the home screen and disabling system apps** (the `DEBLOAT` lists, per-brand package names). It modifies the television;
  Hearth reports on and controls it, and says what it could not read back.
- Its data sources (TMDB, Open-Meteo, Binance) and the crypto/weather widgets. Nothing in Hearth wants them.
- Anything about Titan OS: it has no coverage, and what is learned from a Titan OS build goes in the private repository, as always.

## Experiments, in the order worth doing

Each ends `verified`, `unverified`, `unsupported` or `failed` on a named television, and the result goes in the capability matrix with a date.
Until then every row above marked unverified stays that way.

1. **HKC (Tizen 7): can it switch and read inputs?** Add `tv.window` to a throwaway `config.xml`, call `tizen.systeminfo VIDEOSOURCE` and
   `tizen.tvwindow.setSource` from a test page, and record what the set says — success, a privilege error, or a refusal. This decides
   whether the `⛔` was ever true.
2. **Replace the two constants** (`getInputSource` → `"tv"` on Tizen, `"app"` on webOS) with a real read or an honest `unsupported`.
3. **webOS on a real LG** (none is available yet): `listLaunchPoints`, `launch com.webos.app.hdmiN`, `getAllInputStatus`,
   `getForegroundAppInfo`, and the two permission lists.
4. **A Device Graph source from `VIDEOSOURCE` / `getAllInputStatus`**, if (1) and (3) answer: ports with something on them, with the
   owner's own names, from the television itself.
5. **A rule for older engines**: decide whether a 2016–2019 target is a goal before spending effort on it.

**2026-10-21, later: a port with a signal.** With a device on HDMI 1, `setSource` plus the viewer took the HKC from TV 1 to HDMI 1 (read back, 1.6 s,
`signal: true`), and the owner, watching, saw that device's picture for the whole 30 s hold; the probe then put the television back on TV 1. That closes the
"port with a signal not yet watched" caveat for this one set and this one certificate. The JSON page the owner kept seeing is the probe's own, which prints its
findings and relaunches itself after the viewer; it is not what a person should ever see (STATUS, Remaining 8).
