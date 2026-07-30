# Project Status

A snapshot of what's built, what's verified, and what remains. For the full plan
see [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md).

_Last updated: 2026-07-30 · target release: v0.1.0_

**Group A of [`../HANDOFF.md`](../HANDOFF.md) (everything doable without hardware)
is complete.** The remaining work needs an emulator, a GPU or a device.

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
```
