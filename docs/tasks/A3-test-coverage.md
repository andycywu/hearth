# A3 — Raise test coverage

## Why
Current suites cover the agent loop, adapters (contract), streaming, scripted
brain, diagnostics, ui helpers and cross-target acceptance (54 tests). Gaps:
media tools, input-source tools, diagnostics write-path, and navigation
readiness. Close them.

## Tasks

### A3.1 — Media + input-source tool tests (`packages/core`)
File: **new** `packages/core/src/tools/tv-tools.test.ts`.
- Build a fake `PlatformProvider` (copy the one in `agent.test.ts`, ensure it
  has `media`, `getMute`, `findAppsByName`).
- `createTvTools(platform)` → find each tool by `spec.name`, call `execute`,
  assert it calls the right HAL method / returns `{ ok: true }`.
- Assert **media tools are only present when `has("media")`** (test with a
  provider whose `has` returns false for media → no `media_*` tools).
- Assert `set_input_source` / `launch_app` specs have `confirm: true`.

### A3.2 — Diagnostics write-path (`packages/core`)
Extend `packages/core/src/diagnostics/probe.test.ts`:
- With `allowWrites: true` on the web adapter, assert `system.setVolume` probe is
  `ok` and volume is restored to its original value afterwards.
- Assert `navigation.available` reports `ok`/`ready` on web; `powerStandby` is
  always `skipped`.

### A3.3 — Navigation readiness across adapters (`packages/acceptance` or per-adapter)
- Web: `navigation.isAvailable()` → true.
- AOSP (mocked bridge with `isAccessibilityEnabled: () => false`) →
  `navigation.isAvailable()` → false; with `() => true` → true. (Extend the aosp
  mock in `packages/acceptance/src/mocks.ts` or the adapter test.)

### A3.4 — Connector message mapping
File: extend `packages/llm-connectors/src/openai-compatible.test.ts`:
- Assert `toApiMessage` round-trips an assistant message with `toolCalls` and a
  `tool` result message into the OpenAI wire shape (drive via a mock fetch that
  echoes the request body back so you can inspect it).

## Acceptance
- New tests added and green; total test count increases (target ≥ 62).
- No production code change required unless a test surfaces a real bug (then fix
  the bug, not the test).

## Verify
```bash
pnpm test
```

## Notes
- Keep tests deterministic (no real network/timers where avoidable; use small
  fake fetch impls like the existing streaming/retry tests).
