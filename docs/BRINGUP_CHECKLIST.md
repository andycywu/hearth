# Device Bring-up Checklist (Phase 2)

Step-by-step procedure to verify the agent on real hardware. Run it per target in
the matrix **{MTK, NVT} × {AOSP, Tizen}** (webOS optional). Every capability
result goes into [`platform/capability-matrix.md`](platform/capability-matrix.md).

The bar to hit is the same script the automated cross-target test already proves
in CI (`packages/acceptance`): the on-device run must match it.

> **Doing a POC?** You can avoid vendor signatures entirely — start on emulators,
> scope to public capabilities, and only self-sign on your own eng board later.
> See [`POC.md`](POC.md); skip the privileged/signing steps below.

> Menu paths / SDK flags vary by firmware year — treat the linked official docs
> as authoritative if a command differs.

---

## 0. Prerequisites (one-time)

- [ ] Repo builds on your workstation: `pnpm install && pnpm build && pnpm test`
      (should be green — 54 tests).
- [ ] An LLM endpoint to point at. Easiest first pass: a cloud OpenAI-compatible
      gateway. On-device pass: a localhost server on the TV (see §6).
- [ ] Per platform:
  - **Tizen:** the **Tizen VS Code extension** (Tizen Studio is EOL), which ships
    the `tz` CLI; an author certificate created locally with `tz cert` — no
    Samsung account for public-level capabilities. Samsung TV in Developer Mode.
    Docs: https://docs.tizen.org/
  - **AOSP/Android TV:** Android SDK (adb) + JDK 17; device with ADB debugging.
  - **webOS:** `@webos-tools/cli` (`ares-*`); TV Developer Mode + session.
    Docs: https://webostv.developer.lge.com/

---

## 1. Build the runtime bundle

```bash
pnpm install
pnpm build
pnpm bundle:tizen     # → apps/tizen-app/main.js
pnpm bundle:aosp      # → apps/aosp-app/app/src/main/assets/main.js
pnpm bundle:webos     # → apps/webos-app/main.js
```
- [ ] The three `main.js` files exist.

Set the LLM endpoint the app will use. Either edit the app entry defaults, or set
globals in the app HTML before `main.js` loads:
```html
<script>window.__AGENT_LLM_BASE_URL__="http://<endpoint>/v1";window.__AGENT_LLM_MODEL__="<model>";</script>
```

---

## 2. Tizen (MTK, then NVT)

**Enable Developer Mode** (Samsung TV): Apps → type `12345` → turn Developer Mode
ON → enter your host PC IP → reboot.

```bash
pnpm package:tizen               # bundle + tz build + tz pack (signed .wgt)
sdb connect <TV_IP>
sdb devices                      # confirm the TV is listed
tz install -n apps/tizen-app/Debug/tizen-app.wgt
tz run -n tvaiagent.TvAiAgent
```
One-time certificate setup (no Samsung account for public capabilities) is in
[`EMULATOR_SETUP.md`](EMULATOR_SETUP.md) §A2.
- [ ] App installs and launches; on-screen status shows `model` + `soc`.
- [ ] Note the reported **soc** = mediatek / novatek (from `productinfo`).

**Capability probe:** launch with `?diag` (set the app start URL to
`index.html?diag`, or `index.html?diag&writes` to exercise volume set/restore).
- [ ] Screenshot / copy the Markdown table it renders.
- [ ] Record which privileges installed vs. were rejected (trim `config.xml`
      until it installs; note partner/platform-level ones you couldn't self-sign).

Repeat on the **NVT** Tizen board.

---

## 3. AOSP / Android TV (MTK, then NVT)

**Enable ADB:** Settings → About → click "Build" 7× → enable Developer options →
turn on ADB/Network debugging.

```bash
adb connect <TV_IP>:5555
cd apps/aosp-app
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p tv.titanos.aiagent 1     # or launch from the launcher
```
- [ ] App launches; WebView loads; `TvNativeBridge` present.
- [ ] Volume + list/launch app work (public APIs, no signing needed).

**Enable navigation (no signing):** Settings → Accessibility → **TV AI Agent** →
ON (the app can deep-link here via `openAccessibilitySettings()`).
- [ ] After enabling, `press_key`/navigation works.

**Capability probe:** open the WebView with `?diag` (append to the asset URL) and
copy the report.

**Gated controls (input switch / raw key inject / standby):** these need a
**system/platform-signed** build. On a TitanOS-owned image, sign the APK with the
platform key (or install as a privileged app) and re-test:
- [ ] `set_input_source`, `power_standby`, raw key injection.

Repeat on the **NVT** AOSP board.

---

## 4. webOS (optional)

```bash
pnpm bundle:webos
cd apps/webos-app
ares-package .
ares-setup-device                 # register the TV (one-time)
ares-install ./tv.titanos.aiagent_0.1.0_all.ipk -d <device>
ares-launch tv.titanos.aiagent -d <device>
```
- [ ] Launch with `?diag`; copy the report. (`ares-inspect` opens devtools.)

---

## 5. Acceptance run (per device)

Speak or type this script and confirm identical behaviour to the CI baseline:

| # | Command | Expected |
|---|---------|----------|
| 1 | "set volume to 30" | volume → 30 |
| 2 | "make it louder" | reads then sets volume → 40 |
| 3 | "mute" | muted = true |
| 4 | "open Netflix" | searches, then launches Netflix |
| 5 | "what's the volume?" | replies "40" |

- [ ] Tool sequence matches: `set_volume, get_volume, set_volume, set_mute,
      search_app_by_name, launch_app, get_volume`.
- [ ] End state: volume 40, muted. (Same as `packages/acceptance`.)
- [ ] Try the Chinese variants ("音量調到 30", "現在音量多少?") — replies in Chinese.

---

## 6. On-device inference (M5)

On the TV (or a box on the same LAN), run an OpenAI-compatible server and point
the app at it — see [`on-device-inference.md`](on-device-inference.md).
- [ ] Agent completes the §5 script driven by the **local** model.
- [ ] Record model size, RAM headroom, and per-command latency on the weakest SoC.

---

## 7. Record results & sign off

- [ ] Fill [`platform/capability-matrix.md`](platform/capability-matrix.md) for all
      four cells (paste the `?diag` tables).
- [ ] File issues (use the "Platform bring-up report" template) for any ⚠️/❌.

**Milestone sign-off:**
- **M3 First device** — §5 passes (volume + launch) on one MTK **or** NVT board.
- **M4 Full matrix** — §5 + capability contract pass on all four cells.
- **M5 On-device LLM** — §6 passes with a local model.

---

## Troubleshooting

- **`sdb`/`adb` can't see the TV:** same subnet? firewall? re-toggle Developer/ADB
  mode; re-enter host IP (Tizen).
- **White screen / no content:** the bundle didn't copy — re-run the `bundle:*`
  step; check the WebView/engine console (`ares-inspect`, Android `chrome://inspect`,
  Tizen Web Inspector).
- **CSP blocks the model call:** widen `connect-src` in the app `index.html` to
  include your endpoint origin (see `docs/SECURITY_REVIEW.md`).
- **A capability throws "not supported":** expected on unprivileged builds — it's
  recorded as ⚠️ in the matrix; unlock via partner/platform/system signing.
