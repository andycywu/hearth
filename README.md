# Hearth

[![CI](https://github.com/andycywu/tv-ai-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/andycywu/tv-ai-agent/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-informational)](.nvmrc)

**An AI agent runtime for smart TVs and living-room devices.** Write the agent
once; run it on Android TV / AOSP, Tizen and webOS, on MediaTek or Novatek
silicon, against a cloud model or one running on the TV itself.

It plans against a model of the room rather than mapping commands, and it
**never claims to have done something it didn't** — every step comes back
`verified`, `unverified`, `unsupported` or `failed`, and the difference is the
point.

### ▶ [Try it in your browser](https://andycywu.github.io/tv-ai-agent/) — no install, no API key, no TV

The demo is the real runtime driving a mock TV. Type *"set volume to 30"*,
*"open Netflix"*, *"音量調到 30"*.

> **What this is:** an experimental, open runtime and a testbed for agents that
> control real living rooms — plus [**the Hearth Report**](docs/platform/capability-matrix.md),
> a record of what a television can *actually* do, one verified device at a time.
>
> **What this is not:** a TV OS, a launcher, a content-search product, or
> anything with support hours. Content discovery is already done well by the
> platforms; we do not compete with it.
>
> **Not affiliated with any TV manufacturer or platform vendor.**

---

## The problem this solves

Adding an assistant to a TV normally means writing it three times. Samsung is a
Tizen web app talking to `webapis.*`, Android TV is Kotlin plus a WebView bridge,
LG is Luna services — and each one gates the interesting capabilities behind a
different signing tier. Most of that work is plumbing, not product.

Then there is the part nobody writes down: **a TV will accept a command and do
nothing**. Android takes an input-switch Intent from a third-party app, returns
without complaint, and stays exactly where it was. An agent built on
`execute → assume success` reports that as done — and from then on its idea of
the room is wrong, and so is everything it plans next.

This runtime puts the plumbing behind one interface, and refuses to guess about
the rest:

```ts
const agent = new Agent({ platform, llm });   // platform = your TV, whichever it is
await agent.run("make it louder and open YouTube");
```

`platform` is a **HAL** implemented by an adapter per OS. Everything above it —
the agent loop, the tools, the UI, your skills — is identical everywhere, and is
verified by [one acceptance script that must produce the same tool sequence on
every target](packages/acceptance).

### Every action ends in one of four honest answers

| | |
|---|---|
| `verified` | it was done, and a read-back agrees |
| `unverified` | it was asked for, and nothing on this device can confirm it |
| `unsupported` | this device cannot do it at all — the capability is withdrawn, not retried |
| `failed` | it was attempted and the device did not end up in the expected state |

Collapsing any of these into "done" is the failure this project exists to avoid.
The same plan — *「我要打 PS5」* — produces three different honest answers across
six targets, and
[the test pins each one by name](packages/acceptance/src/plan-acceptance.test.ts)
so that a regression to "verified" fails rather than reading as an improvement.

## What you get

- **A model of the room, not a command map.** A [World Model](docs/world-model.md)
  of facts with source, confidence and decay; a
  [Capability Graph](docs/capability-graph.md) of what this device can do, with
  preconditions, risk and how each thing is verified; a
  [Device Graph](docs/device-graph.md) of what is in the room and on which port.
  *「我要打 PS5」* resolves HDMI2 by lookup — move the console and the plan
  follows, with no code change.
- **A planner with a verification loop.** Goal → plan → policy → execute →
  verify → world. Two planners share it: a deterministic one that costs **zero
  tokens** for anything it can measure, and [an LLM planner](docs/agent-planner.md)
  for the long tail whose every proposal is validated against the graph before it
  runs.
- **A policy engine** with risk levels, most-restrictive-wins rules, parental and
  enterprise hooks, and an audit event for every decision.
- **A privacy boundary built before the sensor.**
  [Perception](docs/policy-and-safety.md) needs a grant, strips raw frames,
  transcripts and face data from every event, and revokes faster than a source
  can ignore `stop()`.
- **Agent loop** with tool calling, streaming, rolling memory, per-turn timeout,
  and a confirmation gate for high-impact actions
- **Platform HAL + 7 adapters** — AOSP, Tizen, webOS, Linux, browser/mock, plus
  Titan OS and Xumo stubs — all held to one shared contract test
- **Any OpenAI-compatible model** — cloud gateway or `localhost` on the TV
- **Three renderers** over one tested view-model: DOM overlay, 2D canvas, and
  Lightning 3 / Blits WebGL for low-end GPUs
- **Works with no model at all** — an offline scripted brain runs the whole stack
  in CI and in the demo above
- **Bring-up kit**: an on-device capability probe (`?diag`), a device tree
  (`?devices`), goal mode (`?plan`), one-command packaging for all three OSes,
  and an automated on-device acceptance run

## Quick start

```bash
corepack enable pnpm
pnpm install
pnpm dev            # http://localhost:5173 — the demo above, locally
```

Anything not working? `pnpm doctor` checks the whole toolchain — Node, pnpm,
lockfile freshness, the Android SDK and TV image, emulator acceleration, the
Tizen signing profile, the webOS CLI — and prints the one command that fixes each
gap. Platform tooling you don't need is reported as "not set up", not as an error.

Useful flags: `?render=canvas`, `?diag` (capability report), `?skills=weather`
(example skill), `?llm=http://127.0.0.1:11434/v1&model=llama3.2` (real model).

```bash
pnpm test           # 620 tests
pnpm bench          # agent-loop latency (p50/p95 per turn)
```

## Add a skill

```bash
npm create hearth-skill sleep-timer          # or --http for the fetch variant
```

You get a package that already passes its own tests — edit the description, the
parameters and the body. Run it inside this repo and it lands in `packages/` and
wires itself up; run it anywhere else and it's standalone.

A skill is one or more tools. Pure-logic skills — weather, sports, smart home —
need no device privilege, so the same code runs on every TV:

```ts
import { Agent, defineTool } from "@hearthkit/core";

const sleepTimer = defineTool(
  { name: "set_sleep_timer",
    description: "Turn the TV off after a number of minutes.",
    parameters: { minutes: { type: "number", description: "1-240", required: true } },
    confirm: true },
  async ({ minutes }) => ({ ok: true, minutes }),
);

const agent = new Agent({ platform, llm, tools: [sleepTimer] });
```

Arguments are schema-validated before your code runs, thrown errors are fed back
to the model so it can recover, and `confirm: true` routes through the host's
confirmation UI.

When a skill is only "call this URL, keep these fields", skip the code and ship
JSON instead — a **manifest** the runtime interprets, never code it loads. It can
be added to a TV that already shipped, and reviewed by someone who doesn't read
TypeScript:

```json
{
  "name": "get_current_weather",
  "description": "Current temperature at a latitude/longitude.",
  "parameters": { "latitude":  { "type": "number", "description": "Decimal degrees", "required": true },
                  "longitude": { "type": "number", "description": "Decimal degrees", "required": true } },
  "request":  { "url": "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&current=temperature_2m" },
  "response": { "temperatureC": "current.temperature_2m" }
}
```

The host keeps the allowlist of origins any manifest may reach, a manifest can't
send headers or pick its own host, and anything but a GET is forced to ask first
— the reasoning is in [ADR-0002](docs/adr/0002-declarative-skill-manifests.md).
Try it: `pnpm dev` then `?skills=manifest`.

Full guide: [**docs/skills.md**](docs/skills.md) · runnable examples:
[`packages/skills-example`](packages/skills-example) (code) and
[`packages/skill-manifest`](packages/skill-manifest) (data).

## Put it on a TV

```bash
cd apps/aosp-app && ./gradlew :app:assembleDebug   # Android TV  → .apk
pnpm package:tizen                                  # Tizen       → signed .wgt
pnpm package:webos                                  # webOS       → .ipk
```

Then watch it work. `?demo` runs an eight-command script — volume, an app query,
then the same intents in Chinese and Japanese — against the offline brain, so no
model is needed:

```bash
node tools/mock-llm-server.mjs &            # the offline brain over HTTP
adb reverse tcp:8080 tcp:8080
adb shell am start -n tv.aiagent.harness/.MainActivity -e start 'index.html?demo\&confirm=auto'
```

Check what the device actually grants you — the probe prints a capability table
you paste straight into
[`docs/platform/capability-matrix.md`](docs/platform/capability-matrix.md):

```bash
adb shell am start -n tv.aiagent.harness/.MainActivity -e start 'index.html?diag\&writes'
node tools/device-acceptance.mjs      # runs the CI acceptance script on the device
node tools/device-acceptance-tizen.mjs   # the same run, on a Tizen TV or board
```

Verified on an Android TV emulator: 12 capabilities OK, 0 errors, and the
acceptance script reproduces the CI tool sequence exactly. Navigation works with
**no signing** via a user-enabled AccessibilityService. Start at
[`docs/EMULATOR_SETUP.md`](docs/EMULATOR_SETUP.md).

## Architecture

```
   your skills  ─┐
                 ├─▶  @hearthkit/core  ──▶  @hearthkit/platform-api (HAL)
   built-in tools┘     agent loop, tools,          │
                       memory, events              │ implemented by
                                                   ▼
                         adapter-aosp · adapter-tizen · adapter-webos · adapter-web
                         adapter-linux · adapter-titan (stub) · adapter-xumo (stub)
                                                   │
                                                   ▼
                          apps/aosp-app (.apk) · tizen-app (.wgt) · webos-app (.ipk)
```

The core never touches `tizen.*`, an Android bridge or `webOS.*` — that boundary
is what makes one codebase work everywhere. Adding a capability means extending
the HAL, implementing it in *every* adapter, and adding it to the contract test.
See [ADR-0001](docs/adr/0001-web-based-cross-platform.md) for why web-based, and
[`docs/extending.md`](docs/extending.md) for how to extend it.

## Status

Honest version: **the runtime works and is verified on emulators; it has not run
on retail TV hardware yet.**

| | |
|---|---|
| Core, HAL, 7 adapters, world model, planner, policy, perception | ✅ done, 620 tests |
| Packaging for all three OSes | ✅ verified (.apk / signed .wgt / .ipk) |
| Android TV emulator bring-up + acceptance run | ✅ passes |
| Goal mode on the Android TV emulator | ✅ device graph → plan → verify, through logcat |
| Real local model driving a TV | ✅ on the Android **and** Tizen emulators; needs >1.5B for reliable tool chaining |
| Tizen audio (volume, mute) | ⛔ **unexercised** — that emulator has no audio API at all |
| webOS | ⚠️ runs on the TV 26 simulator; audio and app management are stubs there, so unverified |
| Retail MTK / NVT hardware | ⛔ not yet |
| Privileged controls (input switch, standby) | ⛔ by design — needs vendor signing |
| Anything with a second device in it (CEC, IR, AVR, console, camera) | ⛔ needs a room, not just a TV |

### The finding that shaped this project

On every OS whose image we do not own, the flagship scenario is **refused**.
Switching an input needs a platform signature on Android, a partner certificate
on Tizen and on webOS. A third-party app gets volume, mute and app launching —
and those are already well covered by the platforms' own assistants.

That is not a bug to fix. It is the shape of the market, and it is why this is
positioned as an open testbed rather than a product: the interesting capabilities
belong to whoever holds the signing key, and the useful thing an outsider can
build is **the map of what is actually possible where** — which is what the
Hearth Report is.

[`docs/HARDWARE_VERIFICATION.md`](docs/HARDWARE_VERIFICATION.md) is the per-OS
list of what a real TV is still needed for, and why an emulator cannot answer it.
[`docs/STATUS.md`](docs/STATUS.md) has the rest of the detail, including
[the device-only bugs](CHANGELOG.md) that only appeared once it ran on real
hardware.

## Documentation

- [Writing a cross-vendor skill](docs/skills.md) · [Extending (tools, persistence, new OS)](docs/extending.md) · [API reference](docs/api.md)
- [On-device inference](docs/on-device-inference.md) · [Architecture](docs/architecture.md) · [Project status](docs/STATUS.md) · [What still needs a real TV](docs/HARDWARE_VERIFICATION.md)
- Bring-up: [POC plan (no vendor signing)](docs/POC.md) · [emulator setup](docs/EMULATOR_SETUP.md) · [checklist](docs/BRINGUP_CHECKLIST.md)
- Living-room agent design: [world model](docs/world-model.md) · [capability graph](docs/capability-graph.md) · [device graph](docs/device-graph.md) · [planner & verification](docs/agent-planner.md) · [tools & adapters](docs/tool-adapter-design.md) · [policy & safety](docs/policy-and-safety.md)
- [Security review](docs/SECURITY_REVIEW.md) · [Releasing](docs/RELEASING.md) · [Roadmap](docs/roadmap.md) · [platform bring-up plan](docs/DEVELOPMENT_PLAN.md)
- Contributing: [**the Hearth Report**](docs/platform/capability-matrix.md) (what TVs can actually do) · [ten ways in](docs/good-first-issues.md) · [naming & namespaces](docs/adr/0003-name-and-namespace.md)

## Contributing

The most valuable contribution needs no code: **run `?diag` on a television
nobody here owns and tell us what it said.** No company can buy twenty TVs across
five firmware generations; a few dozen people already own them. That is how the
[Hearth Report](docs/platform/capability-matrix.md) gets filled in, and it is the
part of this project that cannot be recreated by writing more software.

Other ways in, roughly by effort:

| | Needs a TV? |
|---|---|
| A device report — `node tools/device-report.mjs`, then paste | yes, any TV |
| A skill, as [code](docs/skills.md) or as a [JSON manifest](packages/skill-manifest) | no |
| A scenario — a goal worth planning that we have not written | no |
| A renderer, a language, a docs fix | no |
| An adapter for an OS we do not cover | yes |

Start at [`CONTRIBUTING.md`](CONTRIBUTING.md) — it has the support tiers, what a
device report should contain, and the short list of what this project will *not*
accept. [`docs/good-first-issues.md`](docs/good-first-issues.md) has ten concrete
places to start, five of which need no hardware. Internal working notes live in
[`docs/internal/`](docs/internal/).

Licensed under [Apache-2.0](LICENSE) — permissive, with an explicit patent grant,
chosen so chipset and OEM partners can adopt it safely.
