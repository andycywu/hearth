# TV AI Agent (Harness) — Platform Bring-up Plan

> **Superseded as the top-level roadmap by [`roadmap.md`](roadmap.md).** The
> product is an AI agent runtime and cross-OS control plane for living-room
> devices; the OS/SoC matrix below is one layer of it, not the whole story. What
> this document says about bring-up, signing and privilege levels is still
> accurate and still needed — read it after [`architecture.md`](architecture.md).

This is the platform plan for an on-device AI agent runtime that runs
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
  by adding an adapter — an **experimental webOS adapter skeleton** already exists
  as proof of this, but is not a v1 target).
- Shipping a proprietary model — inference is pluggable and out of scope here.

## 1. Feasibility — can this actually run on MTK/NVT + AOSP/Tizen?

**Yes, with the chosen web-based approach, and here is why.**

The gating factor for advanced controls is **not a proprietary vendor SDK** — the
Tizen SDK and the Android SDK are both freely available. It is the **signing /
privilege level** the app runs at. The SoC (MTK vs NVT) is largely irrelevant to
this; what matters is the certificate the app is signed with.

- **Tizen**: A native Tizen TV app *is* a web app (`.wgt`) running in the
  system Chromium engine, with `tizen.*` / `webapis.*` Device APIs. Privileges
  are tiered **public / partner / platform**. Volume, app launch/list and
  network are **public** (any Tizen-Studio-signed app). Input-source switching,
  power and some `tvinfo`/`tv-control` APIs are **partner/platform** — they need
  a partner or platform certificate that Samsung grants to business partners, not
  something you can self-sign. MTK and NVT both ship Tizen reference builds; the
  same `.wgt` installs on both — only the granted privilege set differs, which
  the HAL's capability probing handles.
- **AOSP / Android TV**: We host the identical web bundle in a system `WebView`
  and inject a Kotlin native bridge (`addJavascriptInterface`). Public
  `AudioManager` covers volume; app listing/launch uses `PackageManager` +
  Leanback intents — **no special signing**. Switching HDMI input goes through
  the TV Input Framework, where "changing a TV input the calling package does not
  own does nothing" and the TV app is a system app — so a third-party app cannot
  directly switch inputs. Injecting raw key events into *other* apps needs the
  `INJECT_EVENTS` signature permission. Two non-privileged paths exist and are
  implemented: **an AccessibilityService** (user-enabled) for global actions
  (home/back/recents) and directional focus navigation, and a **best-effort
  passthrough-input Intent** for input switching.

- **Cross-SoC**: Because control goes through the OS (Tizen WebAPI / Android
  framework) rather than the chip directly, MTK vs NVT differ mainly in WebView/
  Chromium version and GPU performance, not in the control APIs. The HAL isolates
  those differences.

**Bottom line:** volume, app launch/list, network, navigation and in-app media
are achievable on all four targets **with no special signing**. The advanced
controls (system-wide input switch, standby, raw key injection into other apps)
require a **partner/platform certificate (Tizen)** or **system signature
(Android)** — or the non-privileged AccessibilityService/Intent fallbacks, which
cover a useful subset. A TV-platform vendor that owns the image can **platform/partner
sign on its own devices** to unlock the full set; the open-source build running
on retail TVs degrades gracefully via `has()`.

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
  bridge), plus core validation/agent/UI tests and a full offline agent-loop
  integration test — 26 tests green.
- ✅ Streaming responses (`completeStream` + `token` events); CI now runs
  **build → typecheck → lint (ESLint flat config) → test → bundle → size**.
- ✅ Offline **dev harness** (`apps/dev-harness`, `pnpm dev`) + a deterministic
  **scripted brain** (`createScriptedClient`) let the whole stack run in a
  browser with no TV and no API key.

### Phase 2 — Device bring-up on MTK + NVT (≈ weeks 3–9) — the critical path
Run against a matrix of {MTK, NVT} × {AOSP, Tizen}. See `docs/platform/`.
- **Tizen**: obtain a signing profile (author + distributor), install `.wgt` on
  MTK and NVT Tizen boards, verify each HAL capability with the `?diag` probe,
  and record which **privilege level** each firmware grants. For partner/platform
  APIs (input source, power), use a partner/platform certificate on vendor-owned
  devices. Fill `docs/platform/capability-matrix.md`.
- **AOSP**: build the host APK; verify `AudioManager` + `PackageManager` paths
  (no special signing); enable the AccessibilityService for navigation and try
  the passthrough-input Intent for input switching. For raw key injection or
  guaranteed input control, use a **system/platform signature** on vendor-owned
  devices; implement those bridge methods there.
- Define an **acceptance demo**: a spoken/typed command → the agent changes
  volume, lists apps, launches one, and navigates — identically on all four
  targets.

### Phase 3 — UI shell + voice (≈ weeks 8–13, overlaps Phase 2)
- ✅ `packages/ui` DOM overlay (`mountAgentOverlay`) — streams tokens + tool
  activity, event wiring isolated from rendering. Runnable today via the dev
  harness.
- ✅ 2D single-surface **canvas renderer** (`mountAgentCanvas`) — no DOM reflow.
- ✅ **Lightning 3 / Blits (WebGL)** demo (`apps/blits-demo`, standalone) reusing
  the same agent-event wiring — the low-end-GPU production path. Next: promote it
  into `packages/ui` as the default renderer with DOM fallback.
- ✅ Optional `VoicePipeline` HAL implemented in the web adapter via the Web
  Speech API (ASR + TTS), feature-detected and surfaced through `has("voice")`;
  the dev harness shows a mic button and speaks replies. Native wake-word / ASR
  on Tizen/AOSP still to wire per platform.
- Latency budget and performance profiling on the weakest target SoC.

### Phase 4 — On-device inference + open-source release (≈ weeks 12–16)
- ✅ Local/on-device inference wired: the connector speaks the OpenAI schema, the
  dev harness accepts `?llm=` (Ollama/llama.cpp/vLLM), device entries default to
  loopback. Guide: `docs/on-device-inference.md`. Remaining: benchmark model size
  vs. RAM/latency on real MTK/NVT boards.
- Privacy pass: keep sensitive commands on-device; document the cloud/on-device
  routing policy.
- Open-source hygiene: ✅ Apache-2.0, `SECURITY.md`, `CONTRIBUTING`, issue/PR
  templates, `CHANGELOG.md` (0.1.0 cut), tag-driven **release workflow** +
  `docs/RELEASING.md`, **Dependabot**, **license gate** (`pnpm license:check`, in
  CI), **SBOM** (`pnpm sbom`, CycloneDX), and a **security self-review**
  (`docs/SECURITY_REVIEW.md`). Remaining: push a public repo + external audit;
  tag `v0.1.0`.

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

- **Privilege-gated controls (highest risk).** Input switch / raw key injection /
  standby require a **partner or platform certificate (Tizen)** or a **system
  signature (Android)** — not a proprietary vendor SDK. *Mitigation:* ship the
  public-privilege capabilities first; use the non-privileged fallbacks
  (Android AccessibilityService + passthrough-input Intent) for the rest; keep
  everything behind `has()` so the agent degrades gracefully. A platform vendor can
  platform/partner-sign its own devices to unlock the full set.
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
- Add app/plugin tools → pass `tools: [...]` to `new Agent(...)` (use
  `defineTool`); persist sessions with `persistKey`. See `docs/extending.md`.
