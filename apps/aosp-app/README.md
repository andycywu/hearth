# AOSP / Android TV host

An Android app that hosts the web-based agent runtime in a `WebView` and exposes
the native `TvNativeBridge` consumed by `@tv-ai-agent/adapter-aosp`.

## Build
```bash
pnpm bundle:aosp   # build + bundle runtime into app/src/main/assets/main.js
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
Volume works via the public `AudioManager`. Input-source switching, key
injection and standby need MTK/NVT vendor SDKs or system privileges — see
`docs/platform/aosp-bringup.md`.
