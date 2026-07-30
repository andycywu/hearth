# AOSP / Android TV host

An Android app that hosts the web-based agent runtime in a `WebView` and exposes
the native `TvNativeBridge` consumed by `@tv-ai-agent/adapter-aosp`.

## Build

Needs a JDK 17+ and the Android SDK. The wrapper is committed, so no local Gradle
install is required; `compileSdk 34` and build-tools 34 are downloaded on first
build if the SDK licenses are accepted.

```bash
pnpm bundle:aosp   # build + bundle runtime into app/src/main/assets/main.js
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
If Gradle can't find the SDK, point it there (git-ignored):
```
# apps/aosp-app/local.properties
sdk.dir=C:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```
Android Studio's bundled JDK works: `JAVA_HOME=<studio>/jbr`.

Volume, app list/launch and network work via the public SDK — no special
signing. Navigation runs through a user-enabled **AccessibilityService**
(`docs/platform/aosp-accessibility.md`); input switching is best-effort via the
TV Input Framework. Raw key injection and standby require a system/platform
signature (first-party devices). Details: `docs/platform/aosp-bringup.md`.

Run the on-device capability probe by loading the app with `?diag` (escape the
`&`, which the device shell would read as "run in background"):

```bash
adb shell am start -n tv.titanos.aiagent/.MainActivity -e start 'index.html?diag\&writes'
adb logcat -d -s chromium:I     # the report as copyable text
```

Verified results for the Android TV emulator are in
[`docs/platform/capability-matrix.md`](../../docs/platform/capability-matrix.md);
`node tools/device-acceptance.mjs` re-runs the CI acceptance script on a device.

## How the WebView is set up (and why)

- The bundle is served by `WebViewAssetLoader` on the virtual origin
  `http://appassets.androidplatform.net/assets/`, **not** `file://`: a `file://`
  page has a null origin, so `main.js` — an ES module — is CORS-blocked and the
  runtime never starts.
- That origin is **http** on purpose. On-device model servers (llama.cpp, Ollama)
  are plain http on localhost, and WebView does not exempt localhost from
  mixed-content blocking the way desktop Chrome does, so an https page cannot
  reach them at all. The cost is that the page isn't a secure context, so Web
  Speech / `getUserMedia` are unavailable here — Android voice belongs on the
  native bridge anyway.
- Cleartext http is permitted **for loopback only**
  (`res/xml/network_security_config.xml`); anything else must be https. To use a
  model on another machine, prefer `adb reverse tcp:8080 tcp:8080` over widening
  that allowlist.
- Requests are further constrained by the CSP in `assets/index.html`
  (`script-src 'self'`, `connect-src` limited to loopback and https), and
  navigation is pinned to the app's own origin.
- A `WebChromeClient` renders JS `confirm`/`alert` as real, remote-focusable
  dialogs. Without it WebView silently cancels them, which made every
  confirm-required tool look declined.
- The activity is `singleTop` and reloads on a new intent, so
  `am start -e start "index.html?…"` re-points a running app. Avoid
  `am force-stop`: it makes Android drop the app from the enabled-accessibility
  list, disabling navigation.
