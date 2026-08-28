# HANDOFF — for whoever picks this up next

_Rewritten 2026-08-28. The previous version described a repo that no longer
exists — 163 tests, a `tv-ai-agent` namespace, and a Group A/B/C/D task list
whose software half finished a month ago. If any file here disagrees with
[`../STATUS.md`](../STATUS.md), STATUS is the one that gets updated._

Read in this order: [`README.md`](../../README.md) (what this is and is not) →
[`STATUS.md`](../STATUS.md) (what is built and verified) →
[`roadmap.md`](../roadmap.md) (what to build next) →
[`HARDWARE_VERIFICATION.md`](../HARDWARE_VERIFICATION.md) (why the rest is
blocked on physical objects).

## Where the work is

**The software roadmap is finished.** All ten
[implementation tasks](../roadmap.md#next-10-implementation-tasks) have landed —
task 7, HDMI-CEC, as far as a mock bus can take it. Everything still outstanding
needs hardware nobody here has, and no amount of further code moves it:

| Blocked on | Items |
|---|---|
| A retail Samsung TV | Tizen audio — `volume`/`mute` are unexercised code, that emulator has no audio API |
| MTK / NVT boards | Phase 2 bring-up, the privileged controls, on-device model benchmarks |
| A Raspberry Pi (+ a console and an AVR for the full story) | CEC against a real bus. The transport is written; `node tools/verify-cec.mjs` is the whole task — see [`../cec.md`](../cec.md) |
| A browser with a weak GPU | Blits as the default renderer |

So the highest-value thing that can be done from a desk is **anything that makes
someone else's television answer the question for us** — which is what
[the Hearth Report](../platform/capability-matrix.md) and
`tools/device-report.mjs` exist for.

## Definition of green

Run before every commit. CI runs the same thing:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm bundle:all && pnpm check:size
```

Currently: **746 tests**, 18 packages, clean lint.

## Conventions that are load-bearing

- **The core never learns an OS name.** No `tizen.*`, no Android bridge, no
  DOM-beyond-ES2020 in `packages/core`. A test enforces the vocabulary rule: no
  tool name may contain an OS, and the core tool set must be byte-identical
  across web / Tizen / AOSP / webOS.
- **New device capability** → extend `platform-api`, implement it in **every**
  adapter, add it to `assertProviderContract`, then declare it in
  `capabilities/tv-capabilities.ts`. The tool is a *projection* of the
  capability — never write one by hand. See [`../extending.md`](../extending.md).
- **`unverified` is never reported as success**, and neither is anything else.
  Four outcomes: `verified`, `unverified`, `unsupported`, `failed`. Collapsing
  any of them into "done" is the failure this project exists to avoid.
- **Optional code is removed at build time**, not skipped at runtime. Guard it
  inline with the `define`d identifier itself — see the comment at the top of
  `core/src/features.ts` for the re-export mistake that silently ships the
  feature anyway.
- **No telemetry that phones home.** The only egress is ModelPilot, which a host
  opts into with a credential. See [`../service-metrics.md`](../service-metrics.md).
- Conventional-ish commit messages; update `CHANGELOG.md` under **Unreleased**.

## Gotchas that have cost real time

- **`pnpm` must be on PATH.** `corepack pnpm <cmd>` works for the top-level call,
  but nested scripts invoke `pnpm` directly. `corepack enable pnpm` first.
- **`examples/blits-demo` is deliberately outside the workspace** — install it
  separately (`npm install` in that directory). CI builds it in a separate
  non-blocking job.
- **`pnpm check:size` failing means a dependency bloated a bundle.** Investigate
  before raising the budget in `tools/check-bundle-size.mjs` — the size story is
  a product claim, not a nicety.
- **The Android host needs `local.properties` with `sdk.dir=…`** (git-ignored),
  and `JAVA_HOME=<Android Studio>/jbr` works as the JDK.
- **Mock servers started for tests take a `--idle` timeout for a reason.** Five
  abandoned `mock-modelpilot-server.mjs` processes once held the repository
  directory itself un-renameable, because each holds a working-directory handle.
- **`.gitattributes` normalises to LF.** Windows line endings in a diff are
  expected, not a problem.
- **An emulator's silence reads exactly like success.** Everything it does not
  have, it cannot test. This has produced a device-only defect on every single
  bring-up so far — the list is in [`../STATUS.md`](../STATUS.md).

## The old task specs

[`tasks/`](tasks/README.md) holds the Group A specs (A1–A6), all completed in
July 2026. They are kept for the *format* — context → files → steps → acceptance
→ verification — which is the right shape for writing a new one, and for the
notes recording what was deliberately left undone. They are not a current work
list.
