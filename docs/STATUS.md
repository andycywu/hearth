# Project Status

A snapshot of what's built, what's verified, and what remains. For the full plan
see [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md).

_Last updated: 2026-08-11 · target release: v0.1.0_

**The agent runs end-to-end on two TV emulators, and you can talk to it.** On
Android TV the capability probe is clean (11 ok / 0 errors), the CI acceptance
script passes unchanged, a real local model drives it, and speech works both ways
through the native bridge. On the Samsung Tizen TV emulator the app installs,
apps/storage/network pass and a real local model drives it — but **that emulator
has no audio API at all** (neither `webapis.audiocontrol` nor
`tizen.tvaudiocontrol`), so volume and mute on Tizen are unexercised code and
need a retail TV; an earlier version of this page claimed they passed. The
built-in demo runs the whole agent loop — including Chinese
and Japanese commands moving real device state — with **no network, no endpoint
and no API key**. There is an avatar and a remote-driven on-screen keyboard, so a
TV is no longer limited to whatever was baked into the launch flags. Packaging is
verified for all three hosts (APK / signed `.wgt` / `.ipk`). webOS still needs an
install target; real MTK/NVT boards (B5) and the Blits GPU pass (C1) need
hardware.

## At a glance

| Area | State |
|------|-------|
| Agent core (loop, tools, memory, events, streaming) | ✅ done |
| Platform HAL + adapters (web, Tizen, AOSP, webOS) | ✅ done (4 targets) |
| App hosts (Tizen `.wgt`, AOSP APK, webOS `.ipk`, dev harness) | ✅ bundled; **APK compiles** |
| LLM connectors (OpenAI-compatible + offline scripted) | ✅ done, with retry |
| UI renderers (DOM overlay, 2D canvas, Blits WebGL) | ✅ done, one shared view-model |
| Voice (ASR/TTS + wake word) | ✅ all four adapters — Web Speech on web/Tizen/webOS, native bridge on Android |
| Avatar + on-screen keyboard | ✅ avatar is the default face, `?keyboard` to type — verified on the Android TV **and** Tizen emulators |
| CLI on the device (`apps/cli`) | ✅ same agent loop in a terminal — `tv-agent "set volume to 30"`. Verified against the mock adapter |
| Linux platform (`adapter-linux`) | ✅ all three backends verified against real tooling: `pactl` and `wpctl` in CI every push, `amixer` by hand on an Ubuntu 26.04 VM with a real sound card |
| Translucent overlay | ✅ AOSP only. Tizen/webOS web runtimes can't make a window see-through, so those hosts stay opaque; `?translucent` to try anyway |
| CJK input | ✅ kana keyboard (real characters); Chinese as phrases — an IME is out of scope |
| Confirmation dialog | ✅ focusable 10-foot modal, defaults to No; `window.confirm` only as a no-DOM fallback |
| Skills — code (guide + runnable example) | ✅ `docs/skills.md`, `packages/skills-example` |
| Skills — data (JSON manifests, bundled + installable) | ✅ `packages/skill-manifest`, [ADR-0002](adr/0002-declarative-skill-manifests.md) |
| Offline demo on device (`?demo`, no network) | ✅ verified on the Android **and** Tizen emulators |
| Tests / CI / lint / bundle-size / license / SBOM | ✅ 480 tests, CI green |
| Security (review, WebView hardening, tool confirm) | ✅ self-review done; confirm gate wired on device |
| **Android TV emulator bring-up** | ✅ 11 ok / 0 errors, acceptance script passes |
| **Local-model run on device** | ✅ real model drives the TV; 1.5B too weak to chain tools |
| **Tizen / webOS packaging** | ✅ signed `.wgt` + `.ipk` verified |
| **Tizen TV emulator bring-up** | ✅ installs, runs, offline demo runs — but no audio API on that build, so volume/mute are untested |
| **Tizen against a real model** | ✅ works. The earlier "the emulator's NAT is broken" was a misdiagnosis: `config.xml` declared no `<access>` origin, so the app could not reach *any* host. Fixed |
| **Tizen audio (volume, mute)** | ⛔ needs a retail Samsung TV — see [`HARDWARE_VERIFICATION.md`](HARDWARE_VERIFICATION.md) |
| **webOS install run** | ⛔ needs a TV emulator image or a TV in Developer Mode |
| **Real MTK/NVT device bring-up** | ⛔ needs hardware |
| **Blits promoted to default UI** | ⛔ needs browser/GPU testing |
| **On-device model benchmark** | ⛔ needs hardware |

## Done (verified in CI/sandbox)

- **Core "Harness":** agent loop with per-turn timeout + cancellation, tool
  registry with schema validation, rolling memory (+ persistence via storage),
  typed event bus, token streaming, multilingual replies, custom-tool extension
  point (`defineTool`), confirmation gate for high-impact tools.
- **HAL + 4 adapters** all passing one shared behavioural contract test.
- **Cross-target acceptance test:** identical command script → identical tool
  sequence + end state on web/Tizen/AOSP/webOS (mocked). Hardware-free parity proof.
- **Bundling:** esbuild → per-target `main.js`; bundle-size budget enforced in CI.
- **Offline everything:** `pnpm dev` runs the full stack in a browser with a
  scripted brain — no TV, no API key. `?llm=` points at a local model.
- **On-device inference path:** OpenAI-compatible connector works against
  Ollama/llama.cpp/vLLM (`docs/on-device-inference.md`).
- **Diagnostics:** `runDiagnostics` / `?diag` capability self-probe.
- **AOSP non-privileged paths:** AccessibilityService navigation, passthrough
  input Intent.
- **OSS hygiene:** Apache-2.0, CHANGELOG, release workflow, Dependabot, license
  gate (CI), SBOM, security review, WebView hardening + CSP, full docs.
- **Android host compiles** (Gradle wrapper 8.7 committed, debug APK builds); the
  launch-crash theme bug and API 30+ package-visibility bug are fixed.
- **One shared view-model** (`createAgentViewModel`) behind all three renderers,
  so a new view layer only implements `draw`.
- **Confirm gate + spoken replies on every host** via `createConfirmHandler()` /
  `speakReplies()` — gated tools no longer fire unprompted on a real TV.
- **Skills:** `docs/skills.md` (portable vs capability-gated) plus a runnable
  keyless example, opt-in in the harness with `?skills=weather`.
- **`pnpm bench`:** harness-only per-turn latency (p50 0.03ms / p95 0.14ms on a
  dev laptop) as a regression baseline for TV silicon.
- **First on-device bring-up (Android TV 34 emulator):** `?diag` reports 12 ok /
  0 errors, navigation works with no signing via the AccessibilityService, and
  `tools/device-acceptance.mjs` reproduces the CI tool sequence on the device.
  Five device-only defects were found and fixed in the process — chiefly that the
  ES-module bundle could never load from `file://`, and that Android's cleartext
  policy blocked every call to a local model. Results and the platform quirks that
  are *not* bugs: [`platform/capability-matrix.md`](platform/capability-matrix.md).
- **Second on-device bring-up (Samsung Tizen TV 10.0 emulator):** installs and
  runs; volume, mute, 82 apps, `sendKey` and storage all pass, and `?demo` drives
  the whole agent loop offline — `?diag` afterwards reads the volume the demo's
  Japanese command set, so the tool calls reach the real platform. Four more
  device-only defects found here: `webapis` was never loaded so nothing under it
  could work, launch flags never reached `location.search` (Tizen drops the query
  from `config.xml`), `--profile` signed with the wrong certificate, and the
  adapter answered confident constants — `isOnline: true`, `connectionType:
  "none"` — where it should have measured. The emulator's own NAT is broken and
  that is written up with the full elimination, since the obvious suspects
  (proxy, bridge, firewall, VPN) are all wrong.
- **Avatar, keyboard and voice:** an abstract form drawn in code with four states
  driven by agent events (the default renderer), a remote-driven on-screen keyboard
  (`?keyboard`), and speech both ways. Verified on the Android TV emulator by
  typing "mute" letter-by-letter with real D-pad events — `?diag` afterwards read
  `getMute ✅ true` — and by pressing 🎤 Speak, which drove the permission dialog
  and then opened the microphone (`RecognitionService#onMicrophoneOpened`, with
  Android's own green mic indicator lit). Voice needs no native code on
  web/Tizen/webOS: their WebViews are Chromium and expose Web Speech, which
  contradicted the assumption that Samsung would require a partner agreement.
- **A confirmation dialog you can answer from a sofa,** replacing
  `window.confirm` — which blocks the JS thread, isn't reliably D-pad focusable
  and is stubbed out on some TV builds, silently turning the gate into "always
  approve". Defaults to No; Back declines. Two device-only defects fixed on the
  way: Android routes hardware BACK to the Activity rather than the WebView (so
  Back closed the app instead of declining), and an inline `display:flex` beats
  `[hidden]`, so the dialog stayed on screen after being answered. Both paths
  verified on the emulator.
- **Skills as data:** a skill can be a JSON manifest rather than TypeScript,
  bundled or installed into `platform.storage`, with the host owning the origin
  allowlist ([ADR-0002](adr/0002-declarative-skill-manifests.md)).

## Test coverage (348 tests)

ui 114 · core 59 · skill-manifest 56 · llm-connectors 44 · adapter-aosp 25 ·
skills-example 13 · adapter-tizen 11 · platform-api 8 · create-skill 8 ·
adapter-webos 6 · adapter-web 5 · acceptance 5.

## Remaining — needs external resources

1. **Phase 2 device bring-up (critical path).** Install on MTK + NVT boards
   (Tizen + AOSP), run `?diag`, fill `docs/platform/capability-matrix.md`,
   obtain signing (partner/platform on Tizen, system on Android) for the gated
   controls. Compare against the acceptance-test baseline.
2. **Blits → default UI.** The renderer already shares the view-model and builds
   in CI; what's left is validating WebGL rendering/perf on the weakest target
   GPU, then deciding whether it becomes the default with a DOM fallback (needs a
   browser/device).
3. **On-device model benchmark.** Measure model size vs. RAM/latency on real
   silicon; finalize cloud/on-device routing policy.
4. **Tizen audio on a retail TV.** A real model on Tizen now works (the blocker
   was a missing `<access>` origin, not the emulator's NAT). What remains is
   audio: the emulator exposes neither audio API, so `volume` and `mute` have
   never executed on this platform. A retail TV in Developer Mode is also where
   Samsung's `webapis` exists, so it settles the rest of that surface at once.
5. **npm publish.** Waiting on the `@tv-ai-agent` npm organization; GitHub Pages
   needs enabling in the repo settings for the hosted demo.

## How to run

```bash
pnpm install && pnpm build && pnpm test    # verify
pnpm dev                                    # browser demo (offline)
pnpm bundle:tizen | bundle:aosp | bundle:webos   # device bundles
pnpm bench                                  # agent-loop latency
cd apps/aosp-app && ./gradlew :app:assembleDebug   # Android host (JDK 17+, SDK)
pnpm package:tizen                          # signed .wgt   (needs tizen-core `tz`)
pnpm package:webos                          # .ipk          (needs @webos-tools/cli)

# On a connected Android device/emulator:
node tools/mock-llm-server.mjs &            # offline brain over HTTP
adb reverse tcp:8080 tcp:8080
node tools/device-acceptance.mjs            # CI acceptance script, on the device
```
