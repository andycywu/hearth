# AOSP / Android TV host

An Android app that hosts the web-based agent runtime in a `WebView` and exposes
the native `TvNativeBridge` consumed by `@tv-ai-agent/adapter-aosp`.

## Build
```bash
pnpm bundle:aosp   # build + bundle runtime into app/src/main/assets/main.js
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
Volume, app list/launch and network work via the public SDK — no special
signing. Navigation runs through a user-enabled **AccessibilityService**
(`docs/platform/aosp-accessibility.md`); input switching is best-effort via the
TV Input Framework. Raw key injection and standby require a system/platform
signature (first-party devices). Details: `docs/platform/aosp-bringup.md`.

Run the on-device capability probe by loading the app with `?diag`.
