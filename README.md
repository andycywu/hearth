# TV AI Agent

[![CI](https://github.com/andycywu/tv-ai-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/andycywu/tv-ai-agent/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-informational)](.nvmrc)

**An on-device AI agent runtime for Smart TVs.** Write the agent once; run it on
Android TV / AOSP, Tizen and webOS, on MediaTek or Novatek silicon, against a
cloud model or one running on the TV itself.

### ▶ [Try it in your browser](https://andycywu.github.io/tv-ai-agent/) — no install, no API key, no TV

The demo is the real runtime driving a mock TV. Type *"set volume to 30"*,
*"open Netflix"*, *"音量調到 30"*.

---

## The problem this solves

Adding an assistant to a TV normally means writing it three times. Samsung is a
Tizen web app talking to `webapis.*`, Android TV is Kotlin plus a WebView bridge,
LG is Luna services — and each one gates the interesting capabilities behind a
different signing tier. Most of that work is plumbing, not product.

This runtime puts the plumbing behind one interface:

```ts
const agent = new Agent({ platform, llm });   // platform = your TV, whichever it is
await agent.run("make it louder and open YouTube");
```

`platform` is a **HAL** implemented by an adapter per OS. Everything above it —
the agent loop, the tools, the UI, your skills — is identical everywhere, and is
verified by [one acceptance script that must produce the same tool sequence on
every target](packages/acceptance).

## What you get

- **Agent loop** with tool calling, streaming, rolling memory, per-turn timeout,
  and a confirmation gate for high-impact actions
- **Platform HAL + 4 adapters** (AOSP, Tizen, webOS, browser/mock), all held to
  one shared contract test
- **Tools out of the box**: volume, mute, input source, list/search/launch apps,
  remote-key navigation, media transport — each hidden automatically when the
  device can't do it
- **Any OpenAI-compatible model** — cloud gateway or `localhost` on the TV
- **Three renderers** over one tested view-model: DOM overlay, 2D canvas, and
  Lightning 3 / Blits WebGL for low-end GPUs
- **Works with no model at all** — an offline scripted brain runs the whole stack
  in CI and in the demo above
- **Bring-up kit**: an on-device capability probe (`?diag`), one-command
  packaging for all three OSes, and an automated on-device acceptance run

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
pnpm test           # 194 tests
pnpm bench          # agent-loop latency (p50/p95 per turn)
```

## Add a skill

```bash
npm create tv-agent-skill sleep-timer          # or --http for the fetch variant
```

You get a package that already passes its own tests — edit the description, the
parameters and the body. Run it inside this repo and it lands in `packages/` and
wires itself up; run it anywhere else and it's standalone.

A skill is one or more tools. Pure-logic skills — weather, sports, smart home —
need no device privilege, so the same code runs on every TV:

```ts
import { Agent, defineTool } from "@tv-ai-agent/core";

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
confirmation UI. Full guide: [**docs/skills.md**](docs/skills.md) · runnable
example: [`packages/skills-example`](packages/skills-example).

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
```

Verified on an Android TV emulator: 12 capabilities OK, 0 errors, and the
acceptance script reproduces the CI tool sequence exactly. Navigation works with
**no signing** via a user-enabled AccessibilityService. Start at
[`docs/EMULATOR_SETUP.md`](docs/EMULATOR_SETUP.md).

## Architecture

```
   your skills  ─┐
                 ├─▶  @tv-ai-agent/core  ──▶  @tv-ai-agent/platform-api (HAL)
   built-in tools┘     agent loop, tools,          │
                       memory, events              │ implemented by
                                                   ▼
                         adapter-aosp · adapter-tizen · adapter-webos · adapter-web
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

Honest version: **the runtime works and is verified on an emulator; it has not
run on retail TV hardware yet.**

| | |
|---|---|
| Core, HAL, 4 adapters, tools, UI, connectors | ✅ done, 194 tests |
| Packaging for all three OSes | ✅ verified (.apk / signed .wgt / .ipk) |
| Android TV emulator bring-up + acceptance run | ✅ passes |
| Real local model driving a TV | ✅ works; needs >1.5B for reliable tool chaining |
| Retail MTK / NVT hardware | ⛔ not yet |
| Tizen / webOS on-device run | ⛔ needs an emulator image or a TV |
| Privileged controls (input switch, standby) | ⛔ by design — needs vendor signing |

[`docs/STATUS.md`](docs/STATUS.md) has the detail, including
[the five device-only bugs](CHANGELOG.md) that only appeared once it ran on real
Android.

## Documentation

- [Writing a cross-vendor skill](docs/skills.md) · [Extending (tools, persistence, new OS)](docs/extending.md) · [API reference](docs/api.md)
- [On-device inference](docs/on-device-inference.md) · [Architecture](docs/ARCHITECTURE.md) · [Project status](docs/STATUS.md)
- Bring-up: [POC plan (no vendor signing)](docs/POC.md) · [emulator setup](docs/EMULATOR_SETUP.md) · [checklist](docs/BRINGUP_CHECKLIST.md) · [capability matrix](docs/platform/capability-matrix.md)
- [Security review](docs/SECURITY_REVIEW.md) · [Releasing](docs/RELEASING.md) · [Roadmap](docs/DEVELOPMENT_PLAN.md)

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Good places to
start: a new adapter, a skill, or running the bring-up kit on hardware nobody has
tried yet. Internal working notes live in [`docs/internal/`](docs/internal/).

Licensed under [Apache-2.0](LICENSE) — permissive, with an explicit patent grant,
chosen so chipset and OEM partners can adopt it safely.
