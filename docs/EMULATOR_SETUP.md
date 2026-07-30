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

### Or entirely from the command line (no GUI, works headless)
Handy for CI-ish runs and for scripting the whole bring-up. Needs
`cmdline-tools` (SDK Manager → *SDK Tools* → "Android SDK Command-line Tools",
or unzip the
[command-line tools](https://developer.android.com/studio#command-tools) into
`$ANDROID_HOME/cmdline-tools/latest`).

```bash
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"      # Windows; ~/Android/Sdk elsewhere
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"   # Studio's JDK is fine

# Android TV images come in x86 (32-bit) and arm64-v8a only — there is no
# x86_64 TV image. On an x86_64 host, pick x86.
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --list | grep android-tv
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  --install "system-images;android-34;android-tv;x86" emulator platform-tools

echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  -n tv_agent -k "system-images;android-34;android-tv;x86" -d "tv_1080p"

# Headless boot. Check acceleration first: emulator-check accel
"$ANDROID_HOME/emulator/emulator" -avd tv_agent \
  -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
```
On Windows, hardware acceleration comes from **WHPX** — `emulator-check accel`
should say it "is installed and usable"; if not, see §0.

### Install our app
```bash
pnpm bundle:aosp
cd apps/aosp-app && ./gradlew :app:assembleDebug
adb devices                         # emulator-5554 should be listed
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n tv.titanos.aiagent/.MainActivity           # normal launch

# Capability probe. Escape the `&` — adb hands the argv to the device's sh, which
# would otherwise read it as "run in background" and drop the rest.
adb shell am start -n tv.titanos.aiagent/.MainActivity -e start 'index.html?diag\&writes'
adb logcat -d -s chromium:I         # the report, as copyable text
```
- Volume (AudioManager) and app list/launch work on the emulator.
- Enable navigation: Settings → Accessibility → **TV AI Agent** → ON, or from the
  host:
  ```bash
  adb shell settings put secure enabled_accessibility_services \
    tv.titanos.aiagent/tv.titanos.aiagent.TvAgentAccessibilityService
  adb shell settings put secure accessibility_enabled 1
  ```
- The emulator has no HDMI inputs / few TV apps, so `input source` and a short
  app list are expected — that's fine for the POC.

### Automated acceptance run
Instead of typing the five commands by hand, drive the app over the DevTools
protocol and diff the result against the CI baseline:

```bash
node tools/mock-llm-server.mjs &         # the offline brain as an HTTP endpoint
adb reverse tcp:8080 tcp:8099            # device 127.0.0.1:8080 → this host
node tools/device-acceptance.mjs         # PASS/FAIL + platform notes
```
See the verified emulator results in
[`platform/capability-matrix.md`](platform/capability-matrix.md).

### Gotchas we actually hit (Android TV)
- **`adb shell am force-stop` disables navigation.** Stopping the package makes
  Android drop it from `enabled_accessibility_services`, so navigation goes
  unavailable until you re-enable it. Relaunch with `am start` instead — the
  activity is `singleTop` and reloads on a new intent.
- **`am start` on an already-running app** prints "current task has been brought
  to the front" and does *not* redeliver the intent unless the activity handles
  `onNewIntent` (ours does) — otherwise your new `?diag`/`?llm=` flags are ignored.
- **A local model must be reachable over loopback.** Android blocks cleartext http
  by default (targetSdk 28+); the app permits it for loopback only
  (`res/xml/network_security_config.xml`). For a model on your workstation, use
  `adb reverse` so the TV talks to its own `127.0.0.1` — don't widen the
  allowlist or the CSP.
- **Android TV system images are `x86` or `arm64-v8a`** — there is no `x86_64` TV
  image, so `sdkmanager` lists none if you filter for it.

Debug the WebView: `chrome://inspect` in desktop Chrome (with the emulator
running) → inspect the app's WebView.

---

## A2. Tizen TV (VS Code extension + tizen-core)

**Tizen Studio is EOL.** The current toolchain is the **Tizen VS Code extension**,
which ships a CLI called **tizen-core** (`tz`) — it replaces `tizen build-web`,
`tizen package`, Certificate Manager and Emulator Manager. `sdb` is still `sdb`.

```bash
# Windows default; set TIZEN_CORE to override
export TIZEN_CORE="C:/tizen-studio/tools/tizen-core/tz.exe"
"$TIZEN_CORE" --help
```

### Create a dev certificate — no Samsung account needed
`tz` generates an author certificate locally and signs with the bundled **public**
distributor certificate. That covers every capability in the POC's ✅ column; a
**partner** certificate (which does need the Samsung-account flow) is only
required for the privileged rows we deliberately defer — see [`POC.md`](POC.md).

```bash
tz cert -n "Your Name" -p <password, ≥8 chars> -f my-dev
#   → <tizen-studio-data>/keystore/author/my-dev.p12

tz security-profiles add -n my-dev -A \
  -a "C:/tizen-studio-data/keystore/author/my-dev.p12" -p <password> \
  -d "C:/tizen-studio/tools/tizen-core/certificates/distributor/tizen_public_signer.p12" \
  -P tizenpkcs12passfordsigner

tz security-profiles list        # confirms the active profile
```

### Build and sign the .wgt
One command from the repo root — bundles the runtime, generates the icon if
missing, then runs `tz build` + `tz pack`:

```bash
pnpm package:tizen               # → apps/tizen-app/Debug/tizen-app.wgt (signed)
pnpm package:tizen --profile my-dev     # or name a profile explicitly
```

Verified working: a 37 KB signed package containing `config.xml`, `icon.png`,
`index.html`, `main.js`, `style.css`, `author-signature.xml`, `signature1.xml`.

### Install and run
```bash
sdb connect <TV_IP>              # a real TV in Developer Mode, or an emulator
sdb devices
tz install -n apps/tizen-app/Debug/tizen-app.wgt
tz run -n tvaiagent.TvAiAgent    # app id from config.xml
```
For the capability probe, set the app's start page to `index.html?diag`. The
report is also written to the console, so the Web Inspector gives you copyable
text rather than a screenshot.

### What's still missing here (as of 2026-07-30)
- **No TV emulator image is installed** (`tz emul list-vm` is empty, and
  `platforms/*/emulator-images` doesn't exist). Images come from the **Package
  Manager**, whose CLI needs **elevation** — run *Tizen: Package Manager* from the
  VS Code command palette, or `package-manager-cli.exe` from an elevated prompt,
  and install the **TV extension** + a TV emulator image.
- **Web app templates are declared but not installed**
  (`templates/web_app/tizen-10.0/` is empty), so `tz new -T web_app` fails. It
  doesn't matter for us — `apps/tizen-app` is an existing project with its own
  `tizen_web_project.yaml` — but it will bite anyone starting from a template.
- With no emulator, the fastest path to a real check is a **Samsung TV in
  Developer Mode** (Apps → `12345` → Developer Mode ON → host PC IP → reboot),
  then `sdb connect <TV_IP>` and the install commands above.

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
