# Tizen bring-up (MTK / NVT)

## Prerequisites
- The **Tizen VS Code extension** and its `tz` CLI (Tizen Studio is EOL), plus a
  signing profile. `tz cert` + `tz security-profiles add` create one offline and
  that is enough to **build** a signed `.wgt`; **installing** on a Samsung TV or
  its emulator needs a **Samsung** certificate from Certificate Manager (free
  Samsung account). Details: [`EMULATOR_SETUP.md`](../EMULATOR_SETUP.md) §A2.
- TV in Developer Mode; note its IP.

## Steps
1. Build & sign in one step: `pnpm package:tizen` → `apps/tizen-app/Debug/tizen-app.wgt`.
2. Install: `sdb connect <TV_IP> && tz install -p apps/tizen-app/Debug/tizen-app.wgt`.
3. Launch (`tz run -p tvaiagent` — `-p` takes the **package** id from
   `config.xml`, not the application id), open the on-screen status, confirm
   `device.model` / `device.soc`.
4. Walk the HAL: volume, list/launch app, network. Record results in
   `capability-matrix.md`. Use `?diag` for the capability probe — the report goes
   to the console too, so the Web Inspector gives you copyable text.

## Driving and inspecting the emulator

Three things about the emulator that each cost an hour to find:

**The emulator wants the `tizen-dev` profile, not the Samsung one.** A `.wgt`
signed with the Samsung certificate fails to install with
`Check certificate error [-12]`. `pnpm exec node tools/package-tizen.mjs --profile tizen-dev`
switches the active profile for one build and puts it back afterwards. The
Samsung certificate is for retail TVs.

**Screenshots have to come from inside the guest.** The emulator renders through
VIGS, so a host-side window grab (`tools/capture-window.ps1`) captures the frame
and none of the TV's content — you get a plain grey rectangle and no error:

```bash
sdb root on
sdb shell "enlightenment_info -dump_screen /tmp/s"   # always writes /tmp/dump_screen.png
sdb pull /tmp/dump_screen.png shot.png
```

`tz run` on an app that is already running only raises it — the page does not
reload, so a stale screen looks exactly like a change that didn't work. Kill it
first with `sdb shell "app_launcher -k tvaiagent0.TvAiAgent"`.

**Key injection doesn't reach the app.** `enlightenment_input_key Return` (and
`KP_Enter`, `XF86Enter`, …) is accepted and changes nothing on screen. To drive
the running app, use the Web Inspector instead — `app_launcher -w -s <appid>`
prints the port:

```bash
sdb shell "app_launcher -w -s tvaiagent0.TvAiAgent"   # → "with debug 1 port: 44876"
sdb forward tcp:44876 tcp:44876
curl http://127.0.0.1:44876/json/list                 # webSocketDebuggerUrl
```

From there `Runtime.evaluate` over that WebSocket reaches everything the app
exposes — `window.__tvPlatform`, `window.__tvAgent`, `window.__tvVoiceKey()` —
which is how the voice lifecycle was verified here without a remote. Note
`tz run -d` / `--debug-mode` reports `with debug 0`; `app_launcher -w` is the one
that works.

## Privilege levels (the real gate)
Tizen privileges are tiered **public / partner / platform** and the gate is the
signing **certificate**, not a proprietary SDK:
- **public** (any locally generated author cert — `tz cert`): volume,
  `application.*` launch/info, internet. Covers the core agent.
- **partner / platform**: input-source (`tvinfo`/`tv-control`), power. Need a
  **partner or platform certificate** issued by Samsung to partners — you cannot
  self-sign these. On devices you own, sign at partner/platform level to
  unlock them.

## MTK vs NVT notes
- Granted privileges vary by firmware; trim `config.xml` to what installs.
- MTK vs NVT differ mainly in Chromium engine version and GPU performance, not in
  which APIs exist — verify the engine version and keep to the ES2020 baseline.
