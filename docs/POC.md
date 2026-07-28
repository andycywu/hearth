# POC Plan — no vendor signatures required

Goal: demonstrate the agent on TV targets **without asking any vendor for a
signature**. Strategy, in order of preference:

**Stage A — Emulators** → **Stage B — Retail device, dev-signed, public
capabilities** → **Stage C — Your own eng/reference board, self platform-signed.**

The gated controls (HDMI input switch, standby, raw key injection into other
apps) are **out of POC scope** — they stay behind `has()`/`confirm` and simply
report unavailable until Stage C. Everything else needs no special signing.

## Capability scope for the POC

| Capability | POC-safe (no signing) | Needs privilege (defer) |
|------------|:---------------------:|:-----------------------:|
| volume get/set, mute | ✅ | |
| list / search / launch apps | ✅ | |
| network status | ✅ | |
| in-app navigation | ✅ | |
| media transport (own player) | ✅ | |
| LLM chat (cloud or local) | ✅ | |
| voice (ASR/TTS, wake word) | ✅ (where the engine supports it) | |
| input-source switch | | ⛔ partner/platform (Tizen) · system (Android) |
| power standby | | ⛔ |
| key injection into other apps | | ⛔ (AccessibilityService covers nav) |

Target the ✅ column for the POC; it already matches the automated acceptance
script (`packages/acceptance`).

---

## Stage A — Emulators (zero hardware, zero vendor)

Fastest proof of the software path. HDMI inputs / real installed apps don't
exist on emulators, so those probes show empty/unsupported — expected.

### A0. Browser (baseline, no emulator at all)
```bash
pnpm dev            # http://localhost:5173  — offline scripted brain
# add ?render=canvas / ?diag ; ?llm=http://127.0.0.1:11434/v1 for a local model
```

### A1. Android TV emulator (Android Studio)
1. Android Studio → Device Manager → create an **Android TV** AVD (e.g. 1080p).
2. Launch it, then:
   ```bash
   pnpm bundle:aosp
   cd apps/aosp-app && ./gradlew :app:assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
3. Launch the app; open the WebView with `?diag`. Volume (AudioManager) and
   app list/launch work; enable the AccessibilityService for navigation.

### A2. Tizen TV emulator (Tizen Studio)
1. Tizen Studio → **Emulator Manager** → create + launch a TV emulator.
2. Build/install with a **development** certificate (self-service in Certificate
   Manager — no partner deal):
   ```bash
   pnpm bundle:tizen
   cd apps/tizen-app
   tizen build-web -- .
   tizen package -t wgt -s <dev-profile> -- .buildResult
   sdb devices           # emulator shows up
   tizen install -n TvAiAgent.wgt -t <emulator-id>
   ```
3. Launch with `?diag`; run the acceptance script.

> webOS also has an emulator in the webOS TV SDK if you want a third target.

## Stage B — Retail device, developer mode, dev-signed

No vendor involvement: use developer mode + self-service dev certificates.
- **Android TV:** enable ADB, `adb connect`, install the **debug** APK. Public
  capabilities + AccessibilityService navigation.
- **Tizen TV:** Developer Mode (`12345`), install the dev-signed `.wgt`.
See [`BRINGUP_CHECKLIST.md`](BRINGUP_CHECKLIST.md) §2–§3 (skip the privileged
steps for the POC).

## Stage C — Own eng/reference board (self platform-signed)

Only when you want the gated controls in the POC. On a **MediaTek/Novatek
engineering board you own**, you hold the signing keys — so you sign yourself, no
vendor request:
- **Android eng/userdebug build:** `adb root`, push the app to
  `/system/priv-app/`, or sign the APK with the platform key → unlocks
  `INJECT_EVENTS`, TV-input control, `DEVICE_POWER`.
- **Tizen own image:** apply a platform/partner-level certificate to unlock
  `tv-control` / power privileges.
Then implement the stubbed bridge methods (`setInputSource`, `powerStandby`,
`sendKey`) against the now-available APIs.

---

## POC success criteria

- [ ] Agent runs on at least one Android TV **and** one Tizen target
      (emulator or retail).
- [ ] The acceptance script (volume → louder → mute → open app → ask volume)
      passes, matching the CI baseline.
- [ ] Chinese and English both work; streaming visible in the UI.
- [ ] Driven by a local (on-device/LAN) model at least once.
- [ ] `?diag` capability tables captured for each target.

None of the above requires a vendor signature.
