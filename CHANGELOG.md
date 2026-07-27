# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
