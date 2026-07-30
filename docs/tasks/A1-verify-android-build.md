# A1 — Verify the Android host builds

## Why
The Kotlin host (`apps/aosp-app`) was written and edited in an environment
without the Android SDK, so it has **never been compiled**. Recent edits:
`MainActivity` (WebView hardening, `shouldOverrideUrlLoading`, a `start` intent
extra), `TvNativeBridge` (getMute, input-source via TvInputManager, standby,
accessibility routing), `TvAgentAccessibilityService`, manifest + res files.
Compile it and fix anything the compiler flags.

## Prerequisites
- JDK 17, Android SDK (via Android Studio or command-line tools).
- `ANDROID_HOME` set; accept SDK licenses (`sdkmanager --licenses`).

## Steps
1. Produce the web bundle the app embeds:
   ```bash
   pnpm install && pnpm bundle:aosp
   # → apps/aosp-app/app/src/main/assets/main.js
   ```
2. Build the debug APK:
   ```bash
   cd apps/aosp-app
   ./gradlew :app:assembleDebug
   ```
3. Fix compile errors if any. Likely suspects and how to resolve:
   - **`isStreamMute` / `adjustStreamVolume` signatures** — confirm against the
     `compileSdk` (34). Use `AudioManager.isStreamMute(STREAM_MUSIC)` (API 23+).
   - **`TvInputManager` / `TvContract` imports** — ensure `android.media.tv.*`
     is available at `compileSdk 34` (it is). `getLeanbackLaunchIntentForPackage`
     is on `PackageManager`.
   - **`shouldOverrideUrlLoading(WebView, WebResourceRequest)`** — this is the
     non-deprecated overload; keep it.
   - **Kotlin nullability** on `intent?.getStringExtra(...)` — already guarded.
   - **Gradle/AGP/Kotlin versions** — `build.gradle.kts` pins AGP 8.5.0 / Kotlin
     2.0.0; if the local Gradle differs, align the Gradle wrapper
     (`gradle/wrapper/gradle-wrapper.properties`, add if missing) to a compatible
     Gradle (8.7+).
4. If a Gradle wrapper is missing, generate one: `gradle wrapper --gradle-version 8.7`
   (or open the folder in Android Studio and let it sync).

## Acceptance
- `./gradlew :app:assembleDebug` succeeds; `app-debug.apk` produced.
- No changes needed to `packages/*` (this is app-only). Main green gate unaffected.

## Verify
```bash
ls apps/aosp-app/app/build/outputs/apk/debug/app-debug.apk
```
Then (optional, Group B) install on an Android TV emulator and open the probe:
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n tv.titanos.aiagent/.MainActivity -e start "index.html?diag"
```

## Notes
- Commit any fixes with a clear message; update `CHANGELOG.md` if behaviour
  changed. Do **not** loosen the WebView hardening in `MainActivity` to make it
  build — fix the real cause.
