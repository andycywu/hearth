# AOSP / Android TV bring-up (MTK / NVT)

## Prerequisites

- Android SDK + a JDK Gradle can parse; device with `adb` access (Developer Mode).
  Android Studio's bundled JBR is now Java 25, which Gradle 8.7's Kotlin DSL
  rejects with `IllegalArgumentException: 25.0.2` — point `JAVA_HOME` at a JDK 17
  or 21 instead.

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

## Starting a conversation on an emulator

An emulator has no remote, so "press the voice button" is not available — and for
a while it was the only documented way in, which made voice untestable without
`adb`. The on-screen **Speak** button now takes anything the emulator can send,
and all four of these are verified to open the microphone:

| Input | Command | Where it comes from |
| --- | --- | --- |
| OK / D-pad centre | `adb shell input keyevent 23` | a real remote, or the emulator's D-pad panel |
| Enter | `adb shell input keyevent 66` | typing into the emulator window |
| Pointer | `adb shell input tap 960 955` | clicking the button; also touch panels |
| Voice key | `adb shell input keyevent 84` | remotes that have one — routed via `dispatchKeyEvent` |

Note that `adb shell input keyevent` drops events fired in quick succession or
while the emulator is loaded; pace them ~200–300 ms apart.

An `&` inside a launch flag has to be quoted for the *device's* shell, or it
backgrounds the command and the flag silently never arrives:

```bash
adb shell "am start -n tv.aiagent.harness/.MainActivity -e start 'index.html?keyboard&debug'"
```

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
