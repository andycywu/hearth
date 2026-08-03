# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

Device bring-up (Phase 2 tooling):
- **webOS `.ipk` packaging** — `pnpm package:webos` (`tools/package-webos.mjs`).
  Works around two `ares-package` behaviours: it minifies with an old uglify-js
  that can't parse our ES2020 bundle (`-n`, a flag missing from `--help`), and it
  packages the whole app directory, which in a pnpm workspace meant shipping the
  linked `node_modules` tree, the TS source and the sourcemap — 290 KB became
  34 KB with excludes.
- **First run against a real local model** (Qwen2.5-1.5B-Instruct Q4 via
  `llama-server`, reached from the emulator through `adb reverse`): tool calls
  reach `AudioManager` and change device state, but the model skips the chained
  steps (read-then-write, search-then-launch). Measured and tabulated in
  `docs/on-device-inference.md` — **tool *chaining* is what sets the model floor**,
  and 1.5B is below it. `tools/device-acceptance.mjs` now prints a diagnosis
  separating "the platform is broken" from "the model is weak", which is the
  distinction that run made concrete.
- **Tizen packaging moved to `tizen-core` (`tz`)** — Tizen Studio is EOL and the
  toolchain is now the Tizen VS Code extension. `pnpm package:tizen`
  (`tools/package-tizen.mjs`) bundles, builds and signs a `.wgt` in one command,
  with `--flags` to bake `?demo` / `?diag` / `?llm=` into the start page (Tizen
  has no equivalent of Android's `-e start`). Docs updated across
  `EMULATOR_SETUP`, `POC`, `BRINGUP_CHECKLIST`, `RELEASING`,
  `platform/tizen-bringup` and the app README.
- Documented the three Tizen certificate tiers, after an earlier claim here that
  **no Samsung account was needed** turned out to be wrong: a locally generated
  `tz cert` is enough to *build* a signed `.wgt`, but a Samsung TV (including its
  emulator) rejects it at install with `Operation not allowed : :Load archive
  info fail` — that needs a **Samsung** certificate from Certificate Manager
  (free account). A Samsung *partner* certificate remains a third tier, needed
  only for the privileged capabilities the POC defers.
- **App icon** (`pnpm icon`, `tools/make-icon.mjs`): both `config.xml` (Tizen) and
  `appinfo.json` (webOS) referenced an `icon.png` that didn't exist, which breaks
  packaging on both. Drawn in code — no image dependencies — so it can be
  regenerated at any size.
- `resolveLlmEndpoint()` — one precedence rule (`?llm=`/`?model=`/`?key=` → window
  globals → default) shared by all four hosts, so a **shipped** `.wgt`/APK/`.ipk`
  can be repointed at another model by relaunching with a query string instead of
  being rebuilt. The docs already promised `?llm=` on device; now it works.
- `tools/mock-llm-server.mjs` — serves the offline scripted brain as an
  OpenAI-compatible endpoint, so an on-device run uses the exact decisions the CI
  acceptance test asserts (`adb reverse` keeps it inside the app's CSP).
- `tools/device-acceptance.mjs` — runs the `packages/acceptance` script against a
  real/emulated Android device over the Chrome DevTools Protocol and compares the
  tool sequence and end state to the CI baseline. No dependencies; no manual typing.
- `?confirm=auto|deny` bring-up override (`confirmOverrideFromUrl`), logged loudly,
  so an automated run isn't blocked on a native dialog.
- `?diag` now also prints the report to the console, so bring-up can copy it off
  the device (`adb logcat -s chromium:I`, Web Inspector, `ares-inspect`) instead of
  reading a screenshot.
- Hosts expose `window.__tvPlatform` alongside `window.__tvAgent` so a device run
  can assert real device state.
- Custom tool extension point (`AgentOptions.tools`, `defineTool`) and a built-in
  `help` tool.
- Conversation persistence via `platform.storage` (`persistKey` + `restore()`).
- Confirmation gate for high-impact tools (`ToolSpec.confirm`, `AgentOptions.confirm`);
  `set_input_source` and `launch_app` are confirm-required by default.
- Multilingual replies: system prompt answers in the user's language; the offline
  scripted brain replies bilingually (English/Traditional Chinese).
- webOS app host (`apps/webos-app`, `.ipk`); dev-harness `?diag` view + transcript.
- Optional wake-word support in `VoicePipeline` (`startWakeWord`/`stopWakeWord`),
  implemented in the web adapter; hands-free toggle in the dev harness.
- API reference (`docs/api.md`).
- Single-surface **canvas renderer** (`mountAgentCanvas`) reusing the agent event
  wiring, plus a pure `wrapLines` helper (Latin + CJK); dev-harness `?render=canvas`.
- Standalone **Lightning 3 / Blits (WebGL)** demo (`apps/blits-demo`) — same event
  wiring, GPU-rendered; excluded from the workspace/CI (its own install).
- **Cross-target acceptance test** (`packages/acceptance`): one command script runs
  identically on web / Tizen / AOSP / webOS (mocked), asserting the same tool
  sequence and end state — hardware-free Phase 2 proof.
- LLM connector **retry/backoff** for transient failures (network / 5xx / 429).
- Gradle wrapper (8.7) for `apps/aosp-app` so the Android host builds with one
  command; the debug APK now compiles against the Android SDK.
- Shared, DOM-free **agent view-model** (`createAgentViewModel`) in
  `@tv-ai-agent/ui` — one tested reducer over the agent events, consumed by all
  three renderers (DOM overlay, 2D canvas, Blits WebGL), so a new view layer only
  implements `draw`. Blits is now a first-class renderer without adding Vite or
  Blits to `packages/*`.

- `pnpm bench` (`tools/bench.mjs`): p50/p95 per-turn latency of the agent loop
  over the acceptance script, with the offline brain — i.e. harness overhead with
  no model or network noise. README badges (CI / license / Node).
- Japanese replies and intents in the offline scripted brain (`ja`): kana-first
  language detection, verb-final app opening ("Netflix を開いて"), ミュート /
  解除, relative volume, and a `{0}`-template phrase table so the next locale is
  a data edit.
- Non-blocking CI job that builds `apps/blits-demo`, so the WebGL renderer can't
  silently rot while staying out of the workspace toolchain.
- **Skill authoring guide** (`docs/skills.md`): pure-logic vs capability-gated
  skills, why that split decides whether a vendor signature is needed, and the
  rules a portable skill follows.
- **Example skill** `packages/skills-example` — `get_weather` over the keyless
  Open-Meteo API (timeout, flat result, model-readable errors), 13 tests with a
  fake `fetch`. Opt-in in the dev harness via `?skills=weather`.
- The offline scripted brain is now capability-aware: it reads the registered
  tool list and only proposes a custom skill's tool when the host registered it,
  so `?skills=weather` works with no model at all.
- `createConfirmHandler()` and `speakReplies()` in `@tv-ai-agent/ui`, and all
  three device hosts (Tizen / AOSP / webOS) now use them: high-impact tools are
  gated before they fire on a real TV, and replies are spoken where the platform
  advertises voice. The dev harness uses the same two helpers, so "parity with
  the harness" is now shared code rather than a copy per host.
- Test coverage raised from 54 to 105: TV tool behaviour and media capability
  gating, diagnostics write/restore and navigation-readiness paths, AOSP
  accessibility gating, webOS Luna mapping, OpenAI request/message mapping, and
  web-adapter state/`has()` semantics.

Making it usable by someone who didn't write it:
- **`npm create tv-agent-skill <name>`** (`packages/create-skill`, also
  `pnpm new:skill`) — scaffolds a skill package whose tests already pass, so the
  first run is green rather than a compile error. `--http` generates the
  fetch variant with the two things a TV skill needs and a server-side one
  doesn't: an `AbortController` timeout and tests with `fetch` mocked. Inside the
  monorepo it lands in `packages/` and links by `workspace:*`; outside it's
  standalone. 8 tests of its own.
- **`pnpm doctor`** (`tools/doctor.mjs`) — checks Node, pnpm, whether the lockfile
  still covers every workspace package, the Android SDK / TV image / AVD /
  emulator acceleration, the Gradle wrapper, the Tizen signing profile and
  emulator VMs, and the webOS CLI; prints the one command that fixes each gap.
  Every check is there because it cost someone time. Platform tooling you don't
  need reports as "not set up" rather than failing.
- **Every device host now renders something.** `mountDeviceShell()` puts the agent
  overlay plus a status line on screen for AOSP / Tizen / webOS, which previously
  created an agent and showed a blank screen — no reply, tool call or error ever
  reached the display.
- **`?ask=…` (repeatable)** runs commands at startup, so a TV with no keyboard and
  no voice wiring can still be driven — by a launch command, a demo, or bring-up.
  Verified on the emulator, including a Chinese command.
- **Hosted demo**: a GitHub Pages workflow publishes the dev harness, so the
  runtime can be tried with no install, no API key and no TV.
- **`?demo` — a self-running demo on any host.** Eight commands (absolute and
  relative volume, a read-back, an app query, the same intents in Chinese and
  Japanese, mute→unmute so the TV is left as found), each shown on screen as
  `▶ … (4/8)` while it runs; `?demo=loop` for an unattended screen. It needs no
  model — point it at `tools/mock-llm-server.mjs`. Verified end to end on the
  Android TV emulator, driving `AudioManager` through 33 → 40 → 53.

### Changed
- `mountAgentOverlay` / `mountAgentCanvas` render the shared view-model instead
  of each subscribing to the agent bus themselves; public signatures and visual
  behaviour unchanged.
- **README rewritten for people who don't already know the project**, and the
  internal working notes (`HANDOFF.md`, task specs) moved to `docs/internal/` so
  the front page isn't someone else's to-do list.
- **Dropped the TitanOS naming.** The project is independent, so the app identity
  is now `tv.aiagent.harness` (Android package + Kotlin source tree, webOS app id;
  the Tizen widget URI is `https://aiagent.tv/harness`, its `tvaiagent` package id
  unchanged), the webOS vendor is `TV AI Agent`, and `LICENSE`/`NOTICE` read
  `Copyright 2026 TV AI Agent contributors`. Docs that framed privileged signing
  as "TitanOS-owned devices" now say "devices you own" / "a platform vendor",
  which is what was actually meant. Done before publishing on purpose: an app id
  is the installed identity, so changing it later would orphan installs.

### Fixed
- **AOSP: the runtime never started on a device.** `index.html` loads `main.js` as
  an ES module, and module scripts are CORS-blocked from `file://` (null origin),
  so the WebView only ever showed the placeholder page. Assets are now served
  through `WebViewAssetLoader` on a virtual origin.
- **AOSP: no request to a local model could succeed.** Android blocks cleartext
  http from targetSdk 28, so every call to an on-device model server failed with a
  bare "Failed to fetch". Added `network_security_config.xml` permitting cleartext
  for loopback only (not app-wide). The app origin is http for the same reason:
  WebView, unlike desktop Chrome, does not exempt localhost from mixed-content
  blocking, and `MIXED_CONTENT_COMPATIBILITY_MODE` still blocks fetch/XHR.
- **AOSP: relaunching with new flags did nothing.** `am start` on a running app
  didn't redeliver the intent, so `?diag` / `?llm=` were ignored; the activity is
  now `singleTop` and reloads in `onNewIntent`. This also avoids `force-stop`,
  which makes Android drop the app from the enabled-accessibility list and thereby
  disables navigation.
- **AOSP: "not supported" reasons were lost across the bridge.** Android replaces
  anything thrown inside a `@JavascriptInterface` method with a generic "Java
  exception was raised during method invocation", so a merely-unavailable
  capability was reported as a hard **error** in bring-up. The adapter now supplies
  the reason (and points at the accessibility-service setup where relevant).
- AOSP: `list_apps` could report the same app twice — one package can expose
  several launcher activities, and the agent identifies apps by package, so the
  model saw duplicates. Deduped in the bridge.
- **AOSP: volume drifted.** The 0-100 ↔ device-steps conversion truncated in both
  directions, biasing every value down and compounding across relative
  adjustments; it now rounds.
- AOSP: the WebView had no `WebChromeClient`, so `window.confirm()` was silently
  cancelled — every confirm-required tool (switch input, launch app) looked as if
  a user had declined it without ever being asked. The host now shows a real,
  remote-focusable `AlertDialog` for JS confirm/alert.
- AOSP host crashed on launch: `AppCompatActivity` had no `Theme.AppCompat`
  theme. Added `Theme.TvAiAgent` (no action bar, black window background).
- `createAospAdapter()` threw a bare `ReferenceError: TvNativeBridge is not
  defined` instead of its own "are you running inside the AOSP host WebView?"
  message — the guard was unreachable because the global was read directly.
  It now reads the bridge off `globalThis`.
- AOSP `list_apps` / `launch_app` returned almost nothing on API 30+: added the
  `<queries>` launcher-intent declarations required by package visibility
  (instead of `QUERY_ALL_PACKAGES`).
- Refreshed `pnpm-lock.yaml`: it predated `apps/webos-app`, `apps/dev-harness`
  and `packages/acceptance`, so CI's `pnpm install --frozen-lockfile` would have
  failed.

### Security
- WebView hardening on AOSP (`MainActivity`: file-access flags, in-origin
  navigation) and a `Content-Security-Policy` `<meta>` in every app `index.html`.

## [0.1.0] - 2026-07-27

### Added
- Portable agent core ("the Harness"): agent loop, tool registry, LLM
  abstraction, rolling memory, typed event bus.
- Platform HAL (`@tv-ai-agent/platform-api`) with adapters for Tizen, AOSP
  (WebView native bridge) and web/mock, verified by a shared contract test.
- Tool set: volume, mute, input source, list/search/launch apps, key navigation,
  media transport (auto-registered when `has("media")`).
- Streaming responses (`completeStream` + `token` events) and an offline
  scripted brain (`createScriptedClient`) with relative-volume commands.
- Browser **dev harness** (`pnpm dev`) with the UI overlay, Web Speech voice, and
  configurable LLM endpoint via `?llm=`/`?model=`.
- On-device capability **self-diagnostic** (`runDiagnostics`, `?diag`) and a
  capability matrix workflow.
- Android **AccessibilityService** navigation path (no special signing) and
  best-effort input switching via the TV Input Framework.
- Build/test tooling: esbuild bundler, bundle-size budget, ESLint flat config,
  CI (build → typecheck → lint → test → bundle → size), Apache-2.0, docs.

### Notes
- Advanced controls (system-wide input switch, standby, raw key injection) require
  a partner/platform certificate (Tizen) or system signature (Android); the
  open-source build degrades gracefully via `has()`.

[Unreleased]: https://github.com/andycywu/tv-ai-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/andycywu/tv-ai-agent/releases/tag/v0.1.0
