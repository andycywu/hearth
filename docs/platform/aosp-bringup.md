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

## Advanced capabilities — what actually gates them

The gate is **signing/privilege level, not a proprietary SDK** (the Android SDK
is open).

| Capability | Non-privileged path (implemented) | Fully-privileged path |
|---|---|---|
| volume / mute | public `AudioManager` ✅ | — |
| list / launch app | public `PackageManager` + Leanback ✅ | — |
| navigation keys | **AccessibilityService** (user-enabled): home/back/recents + directional focus nav | `INJECT_EVENTS` (system signature) for raw KeyEvents |
| input source | **best-effort passthrough Intent** via `TvInputManager` (varies by build) | system TV app / platform signature |
| power standby | — (not safely reachable unprivileged) | `DEVICE_POWER` (system signature) |

### AccessibilityService (no special signing)
See `docs/platform/aosp-accessibility.md`. The user enables
**Settings → Accessibility → TV AI Agent** once; the bridge then routes
`sendKey` through the service. Global actions (home/back/recents) and directional
focus navigation work on most Android TV UIs.

### For guaranteed control (devices you own)
Sign the host app with the **platform key** (or install as a privileged app) to
gain `INJECT_EVENTS`, TV-input ownership and `DEVICE_POWER`; then implement the
raw paths in `TvNativeBridge`. This is the recommended route on first-party
hardware. The open-source build stays on the non-privileged paths and reports
unavailable capabilities via `has()`.
