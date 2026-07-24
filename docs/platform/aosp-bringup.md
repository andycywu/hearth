# AOSP / Android TV bring-up (MTK / NVT)

## Prerequisites
- Android SDK + JDK 17; device with `adb` access (Developer Mode).

## Steps
1. Bundle: `node tools/bundle.mjs aosp` (copies runtime into `assets/`).
2. Build & install:
   ```bash
   cd apps/aosp-app
   ./gradlew :app:assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
3. Launch; the `WebView` loads the runtime and installs `TvNativeBridge`.
4. Walk the HAL: volume (public `AudioManager`), list/launch app
   (`PackageManager` + Leanback), network. Record in `capability-matrix.md`.

## Privileged / vendor capabilities
- `setInputSource`, `sendKey`, `powerStandby` are stubbed in `TvNativeBridge`.
  They need one of:
  - a **system-signed** or **privileged** app image (platform signature), or
  - the **MTK/NVT vendor TV SDK** (HDMI-CEC, input control, key injection).
- Engage the SoC vendor FAE early; wire the returned SDK calls into the
  corresponding `@JavascriptInterface` methods.
