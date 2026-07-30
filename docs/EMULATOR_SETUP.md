# Emulator setup (Stage A of the POC)

Run the agent on Android TV and Tizen TV **emulators** — no hardware, no vendor
signatures. Do this on your own Windows/macOS/Linux workstation (the emulators
are GUI tools).

## 0. Enable hardware acceleration first (Windows)

Both emulators need CPU virtualization or they won't launch.
- In BIOS/UEFI: enable **Intel VT-x** / **AMD-V**.
- In Windows: enable the **Windows Hypervisor Platform** feature
  (Control Panel → Programs → Turn Windows features on or off), or install the
  Android Emulator hypervisor driver from Android Studio's SDK Manager.

---

## A1. Android TV emulator (Android Studio)

### Install
1. Install **Android Studio** (includes the SDK + emulator).
2. First run → SDK Manager: make sure **Android SDK Platform-Tools** (gives
   `adb`) and at least one **Android TV system image** are installed.

### Create the AVD
1. **More Actions → Virtual Device Manager** (or View → Tool Windows → Device
   Manager) → **Create Virtual Device**.
2. Category **TV** → e.g. **Television (1080p)**.
3. Choose a **system image with Android TV** (e.g. "Android 11 (TV)" or newer);
   download it if needed.
4. Name it, **Finish**, then press **▶** to boot the emulator.

### Install our app
```bash
pnpm bundle:aosp
cd apps/aosp-app && ./gradlew :app:assembleDebug
adb devices                         # emulator-5554 should be listed
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n tv.titanos.aiagent/.MainActivity           # normal launch
adb shell am start -n tv.titanos.aiagent/.MainActivity -e start "index.html?diag"   # capability probe
```
- Volume (AudioManager) and app list/launch work on the emulator.
- Enable navigation: Settings → Accessibility → **TV AI Agent** → ON.
- The emulator has no HDMI inputs / few TV apps, so `input source` and a short
  app list are expected — that's fine for the POC.

Debug the WebView: `chrome://inspect` in desktop Chrome (with the emulator
running) → inspect the app's WebView.

---

## A2. Tizen TV emulator (Tizen Studio)

### Install
1. Download and run the **Tizen Studio** installer (with IDE). Accept the
   license, pick an install dir.
2. Open **Package Manager → Extension SDK** tab → install **TV Extensions** and
   the **Samsung Certificate Extension**.

### Create a dev certificate (self-service — no partner deal)
- **Tools → Certificate Manager → +** → create a **Samsung** author +
  distributor certificate for **TV development** (needs a free Samsung account).

### Create + launch the emulator
1. **Tools → Emulator Manager → Create** → select the **tv** device image →
   Finish.
2. In the emulator's **HW Support** tab, ensure **CPU VT** and **GPU** are **ON**
   (it won't launch otherwise) and give it ≥ **1024 MB** RAM. Launch it.

### Install our app
```bash
pnpm bundle:tizen
cd apps/tizen-app
tizen build-web -- .
tizen package -t wgt -s <your-dev-profile> -- .buildResult
sdb devices                         # the emulator appears
tizen install -n TvAiAgent.wgt -t <emulator-id>
```
- For the capability probe, set the app's start page to `index.html?diag` (or add
  `?diag` when launching) and read the on-screen report.

Debug: Tizen Web Inspector (right-click the emulator → Web Inspector, or via the
Tizen Studio log/inspector tooling).

---

## What to check (both emulators)

Run the acceptance script and confirm it matches the CI baseline
(`packages/acceptance`):

1. "set volume to 30" 2. "make it louder" 3. "mute" 4. "open <an installed app>"
5. "what's the volume?" — and the Chinese variants.

Point at a model with `?llm=` / the `__AGENT_LLM_BASE_URL__` global (a cloud
gateway, or a local server on your LAN — see `on-device-inference.md`).

## Common pitfalls
- **Emulator won't start:** virtualization not enabled (see §0); for Tizen, CPU
  VT/GPU off in HW Support.
- **`adb`/`sdb` doesn't see it:** make sure the emulator finished booting; for
  Android, `adb kill-server && adb start-server`.
- **White screen:** the bundle wasn't copied — re-run the `bundle:*` step.
- **Model call blocked:** widen `connect-src` in the app `index.html` CSP to your
  endpoint origin (see `SECURITY_REVIEW.md`).
- **Slow emulator:** give it more RAM/cores; use a hardware-accelerated (x86_64)
  system image, not ARM.

## Note
I can't install these on your machine from here — they're local GUI tools. If you
hit an error at any step, paste the message and I'll help debug (software-layer
issues I can usually reproduce).

Sources: [Samsung — Installing TV SDK](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html) ·
[Samsung — TV Emulator](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-emulator.html) ·
[Android — Create and manage virtual devices](https://developer.android.com/studio/run/managing-avds)
