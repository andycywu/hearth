# Project Status

A snapshot of what's built, what's verified, and what remains. For the full plan
see [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md).

_Last updated: 2026-07-27 · target release: v0.1.0_

## At a glance

| Area | State |
|------|-------|
| Agent core (loop, tools, memory, events, streaming) | ✅ done |
| Platform HAL + adapters (web, Tizen, AOSP, webOS) | ✅ done (4 targets) |
| App hosts (Tizen `.wgt`, AOSP APK, webOS `.ipk`, dev harness) | ✅ scaffolded + bundled |
| LLM connectors (OpenAI-compatible + offline scripted) | ✅ done, with retry |
| UI renderers (DOM overlay, 2D canvas, Blits WebGL demo) | ✅ done |
| Voice (ASR/TTS + wake word) | ✅ web adapter (Web Speech) |
| Tests / CI / lint / bundle-size / license / SBOM | ✅ 54 tests, CI green |
| Security (review, WebView hardening, tool confirm) | ✅ self-review done |
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

## Test coverage (54 tests)

core 19 · llm-connectors 16 · ui 9 · acceptance 5 · adapter-tizen 2 ·
adapter-web 1 · adapter-aosp 1 · adapter-webos 1.

## Remaining — needs external resources

1. **Phase 2 device bring-up (critical path).** Install on MTK + NVT boards
   (Tizen + AOSP), run `?diag`, fill `docs/platform/capability-matrix.md`,
   obtain signing (partner/platform on Tizen, system on Android) for the gated
   controls. Compare against the acceptance-test baseline.
2. **Blits → default UI.** Promote `apps/blits-demo` into `packages/ui` and
   validate WebGL rendering/perf on the weakest target GPU (needs a browser/device).
3. **On-device model benchmark.** Measure model size vs. RAM/latency on real
   silicon; finalize cloud/on-device routing policy.
4. **First-party skills + tutorial.** Author example skills and a "write a
   cross-vendor skill" guide (deferred).

## How to run

```bash
pnpm install && pnpm build && pnpm test    # verify
pnpm dev                                    # browser demo (offline)
pnpm bundle:tizen | bundle:aosp | bundle:webos   # device bundles
```
