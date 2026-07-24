# TV AI Agent (Harness) — Development Plan

This is the working roadmap for building an on-device AI agent runtime that runs
on **AOSP / Android TV** and **Tizen**, across **MediaTek (MTK)** and
**Novatek (NVT)** SoCs, and is released as open source.

## 0. Goals and non-goals

**Goals**

- One portable agent core ("the Harness") reused across every OS/SoC target.
- Get a real, controllable agent running on MTK and NVT reference boards, on
  both AOSP and Tizen, as the primary success criterion.
- Pluggable LLM: cloud gateway for early iteration, fully on-device later.
- Clean, documented, Apache-2.0 codebase ready to open-source.

**Non-goals (for v1)**

- Being a general test-automation harness (this Harness is the agent runtime).
- Supporting webOS / Fire TV / tvOS on day one (the architecture allows it later
  by adding an adapter; not in the initial scope).
- Shipping a proprietary model — inference is pluggable and out of scope here.

## 1. Feasibility — can this actually run on MTK/NVT + AOSP/Tizen?

**Yes, with the chosen web-based approach, and here is why.**

- **Tizen**: A native Tizen TV app *is* a web app (`.wgt`) running in the
  system Chromium engine, with `tizen.*` / `webapis.*` Device APIs for volume,
  app launch, network, etc. MTK and NVT both ship Tizen reference builds; the
  same `.wgt` installs on both — only the available privileges/APIs differ,
  which the HAL's capability probing handles.
- **AOSP / Android TV**: We host the identical web bundle in a system `WebView`
  and inject a Kotlin native bridge (`addJavascriptInterface`). Public
  `AudioManager` covers volume; app listing/launch uses `PackageManager` +
  Leanback intents. Input-source switching, key injection and standby need
  either a **system/privileged** app signature or the **MTK/NVT vendor SDK** —
  this is the main integration risk and is called out per-platform below.
- **Cross-SoC**: Because control goes through the OS (Tizen WebAPI / Android
  framework) rather than the chip directly, MTK vs NVT mostly differ only in (a)
  which vendor privileges/SDK are needed for advanced control and (b) WebView/
  Chromium version and GPU performance. The HAL isolates those differences.

**Bottom line:** volume, app launch/list, network and navigation are achievable
on all four targets with the current design. The advanced controls (input
switch, standby, hardware key injection) are feasible but gated on vendor SDK
access or a privileged/system app image — plan device bring-up around obtaining
those.

## 2. Phased roadmap

### Phase 0 — Repo & foundation ✅ (this scaffold)
- Monorepo (pnpm workspaces, TypeScript project references).
- Agent core: agent loop, tool registry, LLM abstraction, memory, event bus.
- Platform HAL (`platform-api`) + three adapters (tizen, aosp, web/mock).
- LLM connector (OpenAI-compatible, cloud or localhost).
- App hosts: Tizen `.wgt` skeleton, AOSP WebView + Kotlin bridge skeleton.
- Apache-2.0 license, CI, contributor docs.

### Phase 1 — Harden core + build pipeline (≈ weeks 1–3)
- ✅ **esbuild** pipeline (`tools/bundle.mjs`) produces a single `main.js` per
  target (adapter + core + connector): `pnpm bundle:tizen` / `pnpm bundle:aosp`.
- ✅ Expanded tool set: get/set volume, mute, get/set input source, list apps,
  search app by name, launch app, press key, media transport (play/pause/
  resume/seek). Media tools auto-register only when `has("media")`.
- ✅ Robust agent loop: per-turn timeout (`turnTimeoutMs`) + AbortSignal
  cancellation, tool-arg validation against each tool's schema
  (`validateArgs`, with type coercion + enum checks), structured tool errors
  fed back to the model for recovery.
- ✅ Test coverage: shared adapter **contract test** (`assertProviderContract`)
  run against web, Tizen (mocked `tizen.*`/`webapis.*`) and AOSP (mocked native
  bridge), plus core validation/agent tests — 11 tests green.
- Remaining: streaming responses; CI bundle-size budget check.

### Phase 2 — Device bring-up on MTK + NVT (≈ weeks 3–9) — the critical path
Run against a matrix of {MTK, NVT} × {AOSP, Tizen}. See `docs/platform/`.
- **Tizen**: obtain a signing profile, install `.wgt` on MTK and NVT Tizen
  boards, verify each HAL capability, record which privileges each firmware
  grants. Fill the capability matrix in `docs/platform/capability-matrix.md`.
- **AOSP**: build the host APK; verify `AudioManager` + `PackageManager` paths;
  engage MTK/NVT for the vendor SDK or a system-signed image to unlock input
  switching, key injection and standby; implement those bridge methods.
- Define an **acceptance demo**: a spoken/typed command → the agent changes
  volume, lists apps, launches one, and navigates — identically on all four
  targets.

### Phase 3 — UI shell + voice (≈ weeks 8–13, overlaps Phase 2)
- Build `packages/ui` on **Lightning 3 / Blits** (WebGL) for a smooth 10-foot UI
  on low-end MTK/NVT GPUs; DOM fallback for capable devices.
- Wire the optional `VoicePipeline` HAL (wake word / ASR / TTS) where the
  platform provides it; degrade gracefully via `has("voice")`.
- Latency budget and performance profiling on the weakest target SoC.

### Phase 4 — On-device inference + open-source release (≈ weeks 12–16)
- Stand up a localhost inference server on-device (e.g. llama.cpp / a vendor NPU
  runtime) exposing the OpenAI-compatible schema the connector already speaks;
  benchmark model size vs. RAM/latency on MTK and NVT.
- Privacy pass: keep sensitive commands on-device; document the cloud/on-device
  routing policy.
- Open-source hygiene: security review, dependency/license audit, SBOM,
  `SECURITY.md`, issue/PR templates, first tagged release `v0.1.0`, and a public
  contribution guide. Publish the GitHub repo.

## 3. Milestones & acceptance criteria

| Milestone | Definition of done |
|-----------|--------------------|
| M1 Core green | `pnpm build && pnpm test` pass; demo runs with mock adapter |
| M2 Real bundle | esbuild produces installable Tizen `.wgt` and AOSP APK |
| M3 First device | Agent controls volume + app launch on **one** MTK **or** NVT board |
| M4 Full matrix | All four {MTK,NVT}×{AOSP,Tizen} pass the capability contract tests |
| M5 On-device LLM | Agent completes the acceptance demo with localhost inference |
| M6 OSS release | Public repo, `v0.1.0` tag, license/security audit complete |

## 4. Risks & mitigations

- **Vendor-gated controls (highest risk).** Input switch / key inject / standby
  may require MTK/NVT SDK or a system-signed image. *Mitigation:* engage vendor
  FAEs early (Phase 2 start); ship the non-gated capabilities first; keep them
  behind `has()` so the agent degrades gracefully.
- **WebView/Chromium fragmentation across SoC firmware.** *Mitigation:* target a
  conservative ES2020 baseline (already set), test on each firmware's engine,
  avoid bleeding-edge web APIs.
- **Low-end GPU/CPU performance.** *Mitigation:* Lightning/WebGL UI, aggressive
  context trimming (already in `ConversationContext`), bundle-size budget in CI.
- **On-device model footprint.** *Mitigation:* start cloud-backed; quantized
  small models on NPU; make routing configurable.
- **Open-source readiness.** *Mitigation:* Apache-2.0 from day one, no
  proprietary deps in core, dependency/license audit before release.

## 5. How to work in this repo

- Add a capability → extend `platform-api`, implement in every adapter, add a
  contract test, then expose it as a tool in `packages/core/src/tools`.
- Add an LLM backend → implement `LlmClient` in `packages/llm-connectors`.
- Add a new OS target → add `packages/adapter-<os>` implementing the HAL and an
  app host under `apps/`. No core changes required.
