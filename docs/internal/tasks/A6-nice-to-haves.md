# A6 — Nice-to-haves

Small, independent improvements. Pick any; each should keep the green gate.

## A6.1 — README status badges
Add CI + license badges to the top of `README.md`:
```md
[![CI](https://github.com/andycywu/tv-ai-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/andycywu/tv-ai-agent/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
```
*Acceptance:* badges render on GitHub.

## A6.2 — Agent latency benchmark
**New:** `tools/bench.mjs`. Run the agent (web adapter + scripted client) over N
iterations of the acceptance script; print p50/p95 per-turn latency and total.
Add `"bench": "pnpm build && node tools/bench.mjs"` to root scripts.
*Acceptance:* `pnpm bench` prints timings; no CI wiring required.

## A6.3 — i18n expansion
The scripted brain and system prompt handle en/zh. If needed, add more locales:
- Extract the `STRINGS` table in `packages/llm-connectors/src/scripted.ts` and
  `detectLang` into a small shared module if it grows.
- Add a locale (e.g. `ja`) with translations + a `detectLang` rule; add a test.
*Acceptance:* a new-locale test passes.

## A6.4 — Contributor niceties
- `.github/PULL_REQUEST_TEMPLATE.md` and issue templates already exist — verify
  they render.
- Consider a `CODEOWNERS` file and a short `docs/ARCHITECTURE.md` diagram update
  if the package set changed.

## A6.5 — CI: build the Blits demo (optional)
Add a **separate, non-blocking** CI job that runs
`cd apps/blits-demo && npm ci && npm run build` so the WebGL demo can't silently
rot. Keep it out of the main `build-test` job (different toolchain).

## Verify
```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm bundle:all && pnpm check:size
```
