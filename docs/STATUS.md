# Project Status

A snapshot of what's built, what's verified, and what remains. For the full plan
see [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md).

_Last updated: 2026-07-30 · target release: v0.1.0_

**Group A is complete; B1, B3 and B4 are done on an Android TV emulator** — the app
runs on device, the capability probe is clean, the CI acceptance script passes
unchanged, and a real local model drives it. **Packaging is verified for all three
hosts** (APK / signed `.wgt` / `.ipk`), so Tizen and webOS need only an install
target: a TV emulator image (elevated SDK install) or a TV in Developer Mode. Real
MTK/NVT boards (B5) and the Blits GPU pass (C1) still need hardware.

## At a glance

| Area | State |
|------|-------|
| Agent core (loop, tools, memory, events, streaming) | ✅ done |
| Platform HAL + adapters (web, Tizen, AOSP, webOS) | ✅ done (4 targets) |
| App hosts (Tizen `.wgt`, AOSP APK, webOS `.ipk`, dev harness) | ✅ bundled; **APK compiles** |
| LLM connectors (OpenAI-compatible + offline scripted) | ✅ done, with retry |
| UI renderers (DOM overlay, 2D canvas, Blits WebGL) | ✅ done, one shared view-model |
| Voice (ASR/TTS + wake word) | ✅ web adapter (Web Speech); spoken replies on every host |
| Skills (guide + runnable example) | ✅ `docs/skills.md`, `packages/skills-example` |
| Tests / CI / lint / bundle-size / license / SBOM | ✅ 141 tests, CI green |
| Security (review, WebView hardening, tool confirm) | ✅ self-review done; confirm gate wired on device |
| **Android TV emulator bring-up** | ✅ probe clean, acceptance script passes |
| **Local-model run on device** | ✅ real model drives the TV; 1.5B too weak to chain tools |
| **Tizen / webOS packaging** | ✅ signed `.wgt` + `.ipk` verified |
| **Tizen / webOS install run** | ⛔ needs a TV emulator image or a TV in Developer Mode |
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

## Test coverage (141 tests)

core 37 · llm-connectors 34 · ui 30 · skills-example 13 · adapter-aosp 9 ·
adapter-webos 6 · adapter-web 5 · acceptance 5 · adapter-tizen 2.

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
4. **Real confirm dialogs.** `createConfirmHandler({ ask })` is the seam; each
   platform still needs a focusable 10-foot dialog instead of `window.confirm`.

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
