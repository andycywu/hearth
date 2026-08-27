# Contributing to Hearth

Thanks for your interest. This is an **experimental project and a testbed**, not
a product: Apache-2.0, no support hours, no roadmap promises. What it does have
is a demo you can run in sixty seconds, 620 tests, and a boundary it takes
seriously.

## The most valuable contribution needs no code

**Run it on a television nobody here owns, and tell us what happened.**

No company can buy twenty TVs across five firmware generations. A few dozen
people already own them. That is the whole reason
[the Hearth Report](docs/platform/capability-matrix.md) can exist, and it is the
part of this project that writing more software cannot produce.

On Android TV it is one command — `node tools/device-report.mjs` — which runs the
probe and the four scenarios and writes a finished report into
[`docs/platform/reports/`](docs/platform/reports/). Elsewhere, ask the page
directly: `(await window.__hearthReport({ allowWrites: true })).markdown`. With no
tooling at all, `?diag&writes` prints a table that is already markdown.

Then paste it into the **Device report** issue template, or open a PR.

The single most valuable thing you can report: **a capability that accepted a
command and then did nothing.** No adapter can self-report that, and it is
exactly what the verification loop exists to catch.

## Ways in, if you have no TV

| | What it touches |
|---|---|
| A skill, as [code](docs/skills.md) or a [JSON manifest](packages/skill-manifest) | `packages/skills-*`, no device needed |
| A scenario — a goal worth planning that nobody has written | `core/src/skills/scenarios.ts` |
| A perception source against the mock | `packages/perception-mock` |
| A renderer, a keyboard layout, a language | `packages/ui` |
| Docs, or a device report you found elsewhere and can cite | `docs/` |

`pnpm dev` runs the entire stack in a browser with a scripted brain: no TV, no
API key, no network.

## Dev setup

```bash
corepack enable pnpm
pnpm install
pnpm build && pnpm test
```

## Support tiers

Every adapter someone contributes is one the project inherits. Rather than
pretend otherwise, each target says what it promises:

| Tier | What it means | Today |
|---|---|---|
| **core** | We run it in CI *and* it has been verified on a real device or emulator. Breakage blocks a release. | `adapter-web`, `adapter-aosp`, `adapter-linux` |
| **community** | Has a maintainer and at least one device report. Runs in CI; if it breaks and nobody with the hardware appears, it drops a tier. | `adapter-tizen`, `adapter-webos` |
| **experimental** | A bridge shape and a contract test, no integration. Honest `unsupported` everywhere else. | `adapter-titan`, `adapter-xumo` |

A new adapter starts at **experimental**. It reaches **community** when someone
posts a device report from real hardware. Nothing reaches **core** without
running here.

## Ground rules

- The **core** (`packages/core`) stays platform-agnostic — no `tizen.*`, no
  Android bridge, no `luna://`, no DOM assumptions beyond the ES2020 baseline.
  Adding an OS must touch only its adapter package; if it needs a change under
  `core/src/{world,planner,capabilities,devices,policy}`, that is a design bug
  and we want to discuss it before the PR.
- New device capabilities go through the HAL: extend `platform-api`, implement
  in every adapter, satisfy `assertProviderContract`, then declare a capability
  so the tool is generated from it.
- **Never report an action as done that was not verified.** If a device cannot
  confirm something, the honest answer is `unverified` and it must stay that way
  in the outcome, the summary and the log.
- Keep changes small; add tests; run `pnpm lint` and `pnpm typecheck`.
- By contributing you agree your contributions are licensed under Apache-2.0.

## What this project will not accept

Saying so up front saves everyone an argument:

- **Content search, recommendation, or a launcher.** The platforms do this well
  already. Content is a tool provider here, never core logic.
- **Closed vendor SDK blobs**, or an adapter that cannot be built from source.
- **Telemetry, analytics, or anything that phones home.** The runtime makes no
  network call the host did not configure. ModelPilot calls *are* host-configured
  and carry a pseudonymous, resettable install id so the service can count usage —
  that is the only egress, there is no analytics endpoint, no hardware
  identifiers, and in `off` mode nothing is sent at all. See
  [service-metrics.md](docs/service-metrics.md).
- **Raw camera frames, audio, transcripts or face data crossing the perception
  boundary** — no matter how useful the feature would be. See
  [policy-and-safety.md](docs/policy-and-safety.md).
- **Guessed platform APIs.** A stub that returns typed `unsupported` is worth
  more than code that looks finished and fails on the first real device. If you
  have not run it against the real API, say so in the PR and mark it
  experimental.
- **Making a test pass by weakening a verification.** If a target starts
  reporting `verified` where it used to report `unsupported`, that is either a
  real new capability with a device report behind it, or a regression.

## Commit / PR

- Conventional, descriptive commit messages. Say *why*, not just *what*.
- CI (build, typecheck, lint, test, bundle size, licenses) must pass.
- Note any device testing you did — including "none".

## Review

This is maintained by people with other jobs. A PR that sits for a week has not
been ignored; ping it. If nothing happens for two weeks, ping it again — a stale
queue is the fastest way to lose the first contributor, and we would rather be
reminded than lose you.
