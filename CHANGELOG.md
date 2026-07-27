# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/andycywu/tv-ai-agent/commits/main
