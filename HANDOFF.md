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

> **Group A is complete** (2026-07-30) — everything that needed no hardware. Next
> up is **Group B**, which needs an emulator: start at `docs/EMULATOR_SETUP.md`.

- Monorepo, pnpm workspaces, TypeScript project references. **141 tests green.**
- Packages: `core`, `platform-api`, `adapter-web|tizen|aosp|webos`,
  `llm-connectors`, `ui`, `skills-example`, `acceptance` (cross-target parity
  test).
- App hosts: `apps/tizen-app` (.wgt), `apps/aosp-app` (WebView + Kotlin bridge),
  `apps/webos-app` (.ipk), `apps/dev-harness` (browser), `apps/blits-demo`
  (standalone Lightning 3 / Blits WebGL — **not** in the workspace).
- CI: build → typecheck → lint → test → license → bundle → size. Release workflow
  on `v*` tags. Dependabot, SBOM, security review, WebView hardening all in place.
- Three renderers share one tested view-model (`createAgentViewModel`): DOM
  overlay, 2D canvas, Blits WebGL. Offline "scripted brain" (en/zh/ja) makes the
  whole stack runnable with no model. Voice (Web Speech + wake word) in the web
  adapter; every host gates confirm-required tools and speaks replies.
- The Android host compiles: `apps/aosp-app` has a committed Gradle wrapper, so
  `./gradlew :app:assembleDebug` works given JDK 17+ and the Android SDK.
- `pnpm bench` gives a harness-latency baseline; `?skills=weather` in the harness
  demonstrates a portable skill (`docs/skills.md`).

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

### GROUP A — no hardware needed — **all done (2026-07-30)**
Specs: [`docs/tasks/`](docs/tasks/README.md) — A1…A6. Kept here for context; the
notes record what changed and what was deliberately left for later.

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

- [x] **A4. Wire voice + confirm into the device app entries.** *Done.* Added
  `createConfirmHandler()` / `speakReplies()` to `@tv-ai-agent/ui` (11 tests) and
  wired all three device hosts plus the dev harness to them, so the parity is
  shared code, not three copies. The handler uses `window.confirm` where the
  engine has one and otherwise logs and approves (configurable via `fallback`),
  so a turn can't stall on an invisible dialog. All bundles build within budget.

- [x] **A5. Skill tutorial + example skill.** *Done (owner approved 2026-07-30).*
  `docs/skills.md` explains pure-logic vs capability-gated skills and the rules a
  portable one follows; `packages/skills-example` implements `get_weather` over
  keyless Open-Meteo with 13 mock-`fetch` tests. Opt-in in the harness via
  `?skills=weather`, and it works with the **offline** brain too: the scripted
  client now reads the registered tool list and only proposes a skill's tool when
  the host registered it.

- [x] **A6. Nice-to-haves.** *Done.* README badges (CI/license/Node) + refreshed
  repo layout and dev-harness flags; `pnpm bench` (`tools/bench.mjs`) reporting
  p50/p95 per-turn harness latency; Japanese (`ja`) added to the offline brain
  with a `{0}`-template phrase table; a non-blocking CI job that builds
  `apps/blits-demo`.

### GROUP B — needs emulator or real hardware (Phase 2 bring-up) ← **start here**

Follow `docs/EMULATOR_SETUP.md` (Stage A) then `docs/BRINGUP_CHECKLIST.md`.
No vendor signatures needed for the POC — see `docs/POC.md`.

The debug APK is already built at
`apps/aosp-app/app/build/outputs/apk/debug/app-debug.apk` (rebuild with
`pnpm bundle:aosp && cd apps/aosp-app && ./gradlew :app:assembleDebug`).

- [x] **B1. Android TV emulator** — *done (2026-07-30).* Android TV 34 (x86) AVD,
  debug APK installed, `?diag&writes` clean (12 ok / 0 errors) and the acceptance
  script **PASSES** with the same tool sequence as CI
  (`node tools/device-acceptance.mjs`). Four device-only bugs found and fixed on
  the way — see the notes below. Navigation works with no signing via the
  AccessibilityService.
- [ ] **B2. Tizen TV emulator** — dev-signed `.wgt`, acceptance script + `?diag`.
  **Blocked on you, not on code:** Tizen Studio is installed but has no TV
  extension/emulator image (its package-manager CLI needs elevation) and no
  certificate (needs an interactive Samsung-account sign-in). Details at the top
  of `docs/EMULATOR_SETUP.md` §A2. The Tizen entry already supports `?diag`,
  `?llm=` and `?confirm=`.
- [x] **B3. Fill `docs/platform/capability-matrix.md`** — *done for the AOSP
  emulator column*, including the platform behaviours that differ from the mocks
  (volume quantization, mute zeroing the volume readback, focus-dependent keys).
  Remaining columns need hardware or the Tizen emulator.
- [~] **B4. Point at a local model** (`?llm=` / globals) — *plumbing done and
  proven:* `?llm=` now works on all three device hosts, and the on-device run above
  drove the agent through an HTTP endpoint (`tools/mock-llm-server.mjs`) rather than
  a built-in brain. Pointing at a *real* local model (Ollama/llama.cpp) is the
  remaining step — same command, different `--llm`/`?llm=` value
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

- Both previously-uncompiled parts now build: the Android host (Gradle wrapper is
  committed; `local.properties` with `sdk.dir=…` is git-ignored, add it if Gradle
  can't find the SDK, and `JAVA_HOME=<Android Studio>/jbr` works as the JDK) and
  the Blits demo.
- `apps/blits-demo` is intentionally **outside** the pnpm workspace; install it
  separately (`cd apps/blits-demo && npm install`). CI builds it in a separate
  non-blocking job.
- `apps/tizen-app/Debug/` is committed Tizen Studio output containing a stale copy
  of `src/main.ts`; ignore it, don't edit it. (Left tracked by owner's choice.)
- Windows line endings: `.gitattributes` normalizes to LF — expected.
- If `pnpm` isn't on PATH, `corepack pnpm <cmd>` works, but nested scripts call
  `pnpm` directly — put a `pnpm` shim on PATH (or run `corepack enable pnpm` from
  an elevated shell) before `pnpm build`.
- If `pnpm check:size` fails, a dependency bloated a bundle; investigate before
  raising the budget in `tools/check-bundle-size.mjs`.
- Docs index: `docs/STATUS.md` (snapshot), `docs/DEVELOPMENT_PLAN.md` (roadmap),
  `docs/api.md`, `docs/extending.md`, `docs/skills.md`, `docs/POC.md`,
  `docs/EMULATOR_SETUP.md`, `docs/BRINGUP_CHECKLIST.md`, `docs/SECURITY_REVIEW.md`.
- Deliberately **not** done, so nobody assumes otherwise: real focusable confirm
  dialogs per platform (`createConfirmHandler({ ask })` is the seam — today it
  falls back to `window.confirm`), and the device hosts still mount no UI shell of
  their own (they stash the agent on `window.__tvAgent`; only the dev harness and
  the Blits demo render).

Keep it green, keep the HAL boundary clean, and update `CHANGELOG.md` + this file
as tasks are completed.
