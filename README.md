# TV AI Agent (Harness)

An **open-source, on-device AI agent runtime** for Smart TVs. One portable,
web-based core that runs across operating systems (**AOSP / Android TV** and
**Tizen**) and across SoC vendors (**MediaTek / MTK** and **Novatek / NVT**).

The "Harness" is the agent loop at the center: it takes a user request, asks an
LLM what to do, and drives the TV through a stable set of tools — set volume,
switch input, launch an app, navigate the UI — regardless of the underlying OS
or chipset.

> Status: **v0.1 scaffold.** The architecture, HAL, agent core, adapters and app
> hosts are in place and typecheck/test green. Native platform control paths
> (input switching, key injection, standby) are stubbed with clear TODOs where a
> vendor SDK or system privilege is required. See
> [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md).

## Why web-based, cross-platform?

Tizen's first-class app model *is* a web app, and both Android TV WebView and
Tizen ship a modern Chromium/Blink engine. A single web bundle plus a thin
native bridge per OS gives us maximum code reuse across MTK and NVT builds of
either OS, while keeping the door open to a GPU-accelerated Lightning 3 UI for
low-end silicon. See [ADR-0001](docs/adr/0001-web-based-cross-platform.md).

## Architecture at a glance

```
                +-------------------------------------------+
                |            @tv-ai-agent/core              |
                |   Agent loop · Tool registry · Memory     |
                |   LLM abstraction · Event bus (the Harness)|
                +-------------------+-----------------------+
                                    | uses
              +---------------------v----------------------+
              |        @tv-ai-agent/platform-api (HAL)     |
              |  SystemControl · AppControl · Navigation   |
              |  Network · Storage · (Media/Voice optional) |
              +----+----------------+-----------------+-----+
                   | implements     | implements      | implements
        +----------v----+   +-------v---------+  +----v-----------+
        | adapter-tizen |   |  adapter-aosp   |  |  adapter-web   |
        | tizen.*/WebAPI|   | WebView bridge  |  |  mock (dev/CI) |
        +--------+------+   +--------+--------+  +----------------+
                 |                   |
        apps/tizen-app (.wgt) apps/aosp-app (WebView host, Kotlin)
                 |                   |
        Samsung / MTK / NVT     Android TV / MTK / NVT
```

LLM inference is pluggable via `@tv-ai-agent/llm-connectors`: point it at a
localhost server for **fully on-device** inference, or at a cloud gateway.

## Repository layout

```
packages/
  core/            Platform-agnostic agent runtime (the Harness)
  platform-api/    HAL — capability interfaces the agent uses
  adapter-tizen/   Tizen Web Device API implementation
  adapter-aosp/    Android WebView JS-bridge implementation
  adapter-web/     Browser/mock adapter for dev & CI
  adapter-webos/   Experimental webOS (LG) adapter via Luna Service Bus
  llm-connectors/  Cloud + on-device LLM clients (OpenAI-compatible)
  ui/              (Planned) Lightning 3 / Blits 10-foot UI shell
apps/
  tizen-app/       Tizen web-app host → .wgt
  aosp-app/        Android host app (WebView + native bridge, Kotlin)
tools/             Bundler shim + local demo
docs/              Architecture, dev plan, platform bring-up, ADRs
```

## Quick start (development)

```bash
corepack enable pnpm
pnpm install
pnpm build          # build all packages
pnpm test           # run unit tests (vitest)
node tools/demo.mjs # run the agent locally with the mock adapter
```

Try the agent in a browser — no TV, no API key — with the offline dev harness:

```bash
pnpm dev   # serves http://localhost:5173 (type or speak commands)
```

To drive it with a real/local model, append `?llm=…` (see
[`docs/on-device-inference.md`](docs/on-device-inference.md)).

Building the device apps: see
[`apps/tizen-app/README.md`](apps/tizen-app/README.md) and
[`apps/aosp-app/README.md`](apps/aosp-app/README.md), plus the bring-up guides in
[`docs/platform/`](docs/platform/).

## Roadmap

The phased plan lives in [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md).
Short version: harden the core and build pipeline (Phase 1) → real device
bring-up on MTK + NVT for both AOSP and Tizen (Phase 2) → UI shell and voice
(Phase 3) → on-device inference and public open-source release (Phase 4).

## Documentation

- [Development plan](docs/DEVELOPMENT_PLAN.md) · [Architecture](docs/ARCHITECTURE.md) · [API reference](docs/api.md)
- [Extending (custom tools, persistence, new OS)](docs/extending.md)
- [On-device inference](docs/on-device-inference.md) · [Security review](docs/SECURITY_REVIEW.md) · [Releasing](docs/RELEASING.md)
- Platform bring-up: [Tizen](docs/platform/tizen-bringup.md) · [AOSP](docs/platform/aosp-bringup.md) · [AOSP accessibility](docs/platform/aosp-accessibility.md) · [capability matrix](docs/platform/capability-matrix.md)

## Contributing & license

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Licensed under
[Apache-2.0](LICENSE) (permissive, with an explicit patent grant — chosen so
chipset and OEM partners can adopt it safely).
