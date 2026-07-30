# HANDOFF — for the next Claude (VS Code / Claude Code)

You are picking up an in-progress, healthy repo. Read this first, then
`docs/STATUS.md` and `docs/DEVELOPMENT_PLAN.md`. Work top-down through the task
list; keep the repo green at every step.

## What this project is

An open-source, on-device **AI agent runtime ("Harness") for Smart TVs**, one
web-based core reused across **AOSP / Tizen / webOS** and **MediaTek / Novatek**
SoCs. A portable agent loop drives the TV through a platform HAL; adapters absorb
per-OS differences. See `README.md`.

## Current state (as of this handoff)

- Monorepo, pnpm workspaces, TypeScript project references. **54 tests green.**
- Packages: `core`, `platform-api`, `adapter-web|tizen|aosp|webos`,
  `llm-connectors`, `ui`, `acceptance` (cross-target parity test).
- App hosts: `apps/tizen-app` (.wgt), `apps/aosp-app` (WebView + Kotlin bridge),
  `apps/webos-app` (.ipk), `apps/dev-harness` (browser), `apps/blits-demo`
  (standalone Lightning 3 / Blits WebGL — **not** in the workspace).
- CI: build → typecheck → lint → test → license → bundle → size. Release workflow
  on `v*` tags. Dependabot, SBOM, security review, WebView hardening all in place.
- Three renderers share the same agent-event wiring: DOM overlay, 2D canvas,
  Blits WebGL. Offline "scripted brain" makes the whole stack runnable with no
  model. Voice (Web Speech + wake word) in the web adapter.

## Environment / how to run

Requires Node ≥ 20 and pnpm 9 (`corepack enable pnpm`).

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test   # must all pass
pnpm bundle:all && pnpm check:size                        # device bundles + budget
pnpm dev                                                  # browser demo (offline) http://localhost:5173
```

**Definition of "green" — run before every commit:**
`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm bundle:all && pnpm check:size`

## Conventions (don't break these)

- Core stays platform-agnostic (no `tizen.*`, Android bridge, or DOM-beyond-ES2020
  in `packages/core`).
- New device capability → extend `platform-api`, implement in **every** adapter,
  add to the contract test (`assertProviderContract`), then expose a tool in
  `packages/core/src/tools`. See `docs/extending.md`.
- Tool args are validated against the schema; high-impact tools set
  `confirm: true`.
- Keep test files out of package builds (they're excluded in each `tsconfig`).
- Conventional-ish commit messages; update `CHANGELOG.md` (Unreleased).

---

## TASKS — do these in order

> **Detailed, executable specs live in [`docs/tasks/`](docs/tasks/README.md)** —
> one file per Group A task (context, files, step-by-step, code sketches,
> acceptance, verification). The list below is the summary; open the linked spec
> before starting each.

### GROUP A — no hardware needed (do these first, in VS Code)
Specs: [`docs/tasks/`](docs/tasks/README.md) — A1…A6.

- [x] **A1. Verify the Android host compiles.** *Done.* Added the missing Gradle
  wrapper (8.7); `./gradlew :app:assembleDebug` produces `app-debug.apk` with no
  warnings. Kotlin compiled clean; two real bugs found by review and fixed: the
  `AppCompatActivity` had no `Theme.AppCompat` theme (launch crash) and API 30+
  package visibility made `list_apps`/`launch_app` come back empty (added
  `<queries>`).

- [x] **A2. Promote Blits to a first-class UI renderer.** *Done.* Extracted the
  duplicated agent-event wiring into `createAgentViewModel` in `@tv-ai-agent/ui`
  (10 unit tests); the DOM overlay, the 2D canvas and `apps/blits-demo` all
  consume it, so the renderers differ only in `draw`. Blits/Vite stay out of
  `packages/*` — the demo keeps its own install. `npm run build` in the demo is
  green. *Rendering/perf verification still needs a browser (Group C / C1).*

- [x] **A3. Raise test coverage.** *Done — 54 → 105 tests.* Added: TV tool
  behaviour + media capability gating (`tv-tools.test.ts`), diagnostics
  write/restore + navigation-readiness paths, AOSP accessibility gating and
  volume clamping, webOS Luna mapping and partner-gated degradation, OpenAI
  request/message mapping, web-adapter state and `has()` semantics. Found and
  fixed a real bug: the AOSP adapter's "not found" guard was unreachable
  (`ReferenceError` came first).

- [ ] **A4. Wire voice + confirm into the device app entries.** `apps/tizen-app`,
  `apps/aosp-app/web`, `apps/webos-app` mains currently create the Agent without
  the `confirm` handler or voice UI that the dev harness has. Add a minimal
  confirm handler and (where `has("voice")`) speak replies. *Acceptance:* bundles
  build; behaviour parity with the dev harness.

- [ ] **A5. Skill tutorial + example skill** (was deferred by the owner —
  confirm before doing). Write `docs/skills.md` ("write a cross-vendor skill")
  and a runnable example (e.g. a weather or smart-home tool via `defineTool`),
  wired into the dev harness behind a flag. *Acceptance:* example tool works in
  `pnpm dev`; doc explains the pure-logic vs capability-gated distinction (see the
  chat history / `docs/POC.md`).

- [ ] **A6. Nice-to-haves.** README status badges (CI), a `pnpm bench` latency
  script for the agent loop, expand i18n beyond zh/en if needed.

### GROUP B — needs emulator or real hardware (Phase 2 bring-up)

Follow `docs/EMULATOR_SETUP.md` (Stage A) then `docs/BRINGUP_CHECKLIST.md`.
No vendor signatures needed for the POC — see `docs/POC.md`.

- [ ] **B1. Android TV emulator** — install the debug APK, run the acceptance
  script + `?diag` (`adb shell am start -n tv.titanos.aiagent/.MainActivity -e start "index.html?diag"`).
- [ ] **B2. Tizen TV emulator** — dev-signed `.wgt`, acceptance script + `?diag`.
- [ ] **B3. Fill `docs/platform/capability-matrix.md`** from the `?diag` reports.
- [ ] **B4. Point at a local model** (`?llm=` / globals) and re-run the script
  (`docs/on-device-inference.md`).
- [ ] **B5. Real MTK/NVT boards** (needs hardware) — repeat; for gated controls
  self-sign on your own eng board (POC Stage C) and implement the stubbed bridge
  methods (`setInputSource`, `powerStandby`, `sendKey`).

### GROUP C — needs a browser / GPU

- [ ] **C1. Verify Blits WebGL rendering + perf** on the weakest target GPU;
  tune, then consider making Blits the default renderer with DOM fallback.

### GROUP D — release

- [ ] **D1. Cut `v0.1.0`** once Group A is done and at least one emulator target
  passes: move CHANGELOG Unreleased → a dated version, `git tag v0.1.0 && git push
  origin v0.1.0` (triggers the release workflow). See `docs/RELEASING.md`.

---

## Gotchas / notes

- The prior environment was a sandbox; a couple of hand-off caveats:
  - Kotlin/Android and the Blits demo were **not compiled** there (no Android SDK
    / it's a separate install). Verify locally (A1, A2).
  - `apps/blits-demo` is intentionally **outside** the pnpm workspace; install it
    separately (`cd apps/blits-demo && npm install`).
- Windows line endings: `.gitattributes` normalizes to LF — expected.
- If `pnpm check:size` fails, a dependency bloated a bundle; investigate before
  raising the budget in `tools/check-bundle-size.mjs`.
- Docs index: `docs/STATUS.md` (snapshot), `docs/DEVELOPMENT_PLAN.md` (roadmap),
  `docs/api.md`, `docs/extending.md`, `docs/POC.md`, `docs/EMULATOR_SETUP.md`,
  `docs/BRINGUP_CHECKLIST.md`, `docs/SECURITY_REVIEW.md`.

Keep it green, keep the HAL boundary clean, and update `CHANGELOG.md` + this file
as tasks are completed.
