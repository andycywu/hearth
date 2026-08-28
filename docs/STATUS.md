# Project Status

A snapshot of what is built, what is verified, and by what. For the plan see
[`roadmap.md`](roadmap.md) (product) and [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)
(platform bring-up). For what an emulator structurally cannot answer, see
[`HARDWARE_VERIFICATION.md`](HARDWARE_VERIFICATION.md).

_Last updated: 2026-08-28 · released: v0.1.0 (2026-08-05) · cutting: v0.2.0_

**The honest one-line version: the runtime works and is verified on emulators;
it has not run on retail TV hardware, and nothing with a second device in it has
run at all.**

The agent runs end-to-end on the Android TV and Samsung Tizen emulators and on
the webOS 26 simulator, driven by a real local model, with goal mode — device
graph → plan → policy → execute → verify — proven on the Android TV emulator
through logcat. Packaging is verified for all three hosts (APK / signed `.wgt` /
`.ipk`). What is *not* proven is anything the emulators do not have: Tizen has no
audio API on that image, webOS stubs audio and app management, and CEC, IR, an
AVR, a console, a camera and a far-field microphone need a room rather than a TV.

**752 tests green**, across 18 packages.

## At a glance

| Area | State |
|------|-------|
| Agent core (loop, tools, memory, events, streaming) | ✅ done |
| World Model · Capability Graph · Device Graph · planner · verification · policy | ✅ done, wired into the agent loop |
| Goal mode (`agent.pursue`, `pursueSkill`, `pursueIntent`) | ✅ done, beside the chat path and sharing its world, policy and confirm gate |
| LLM planner (model proposes, graph validates) | ✅ done — five rejections run before anything executes |
| ModelPilot planner (remote decision engine) | ✅ stage 1 — `off`/`shadow`/`enforce`, `shadow` by default, `off` with no key |
| Planning cost meter (`agent.planning`) | ✅ done — the four P0 scenarios plan for **zero tokens**, 1.7 ms average |
| Perception boundary + mock camera | ✅ done — no grant no sensor, raw capture stripped, revocation beats `stop()` |
| Platform HAL + adapters (web, Tizen, AOSP, webOS, Linux) | ✅ 5 implemented, one shared contract test |
| Titan OS / Xumo adapters | 🟡 stubs: bridge shape + contract test, no integration. Both in the 6-target acceptance run |
| Host boot (`@hearthkit/host`) | ✅ one boot sequence for all four hosts, replacing four divergent copies |
| Build profiles (`--full` / `--with` / `--without`) | ✅ optional code removed at build time, not skipped at runtime — 74 / 95 / 121 KB |
| Install identity + service metrics | ✅ random, local, resettable id on ModelPilot calls only; no analytics endpoint exists |
| Device report (`tools/device-report.mjs`) | ✅ one command turns a TV into a pasteable markdown section |
| LLM connectors (OpenAI-compatible + offline scripted) | ✅ done, with retry |
| UI renderers (avatar, DOM overlay, 2D canvas, Blits WebGL) | ✅ one shared view-model behind all of them |
| Voice (ASR/TTS + wake word) | ✅ all four adapters — Web Speech on web/Tizen/webOS, native bridge on Android |
| CLI on the device (`apps/cli`) | ✅ same agent loop in a terminal |
| Skills — code and JSON manifests | ✅ guide, runnable example, installable manifests |
| Tests / CI / lint / bundle-size / license / SBOM / secrets gate | ✅ 752 tests, CI green |
| **Android TV emulator bring-up** | ✅ 11 ok / 0 errors, acceptance script passes |
| **Goal mode on the Android TV emulator** | ✅ verified 2026-08-18, two device-only defects found and fixed |
| **Local model driving a real TV** | ✅ on the Android **and** Tizen emulators; 1.5B is too weak to chain tools |
| **Tizen emulator bring-up** | ✅ installs, runs, offline demo runs, real model works |
| **webOS install run** | ✅ runs on the TV 26 Simulator; audio and app management are stubs there |
| **Linux platform** | ✅ all three backends against real tooling — `pactl`/`wpctl` in CI, `amixer` on a real sound card |
| **Tizen audio (volume, mute)** | ⛔ unexercised code — that emulator has no audio API at all |
| **HDMI-CEC** | 🟡 transport, discovery, verified power, a `cec-ctl` implementation for Linux, and a one-line host hook — mock- and fixture-tested, **no real bus has run it**. `node tools/verify-cec.mjs` is how that changes. [`cec.md`](cec.md) |
| **Real MTK/NVT device bring-up** | ⛔ needs hardware |
| **Blits promoted to default UI** | ⛔ needs browser/GPU testing |
| **On-device model benchmark** | ⛔ needs hardware |

## Test coverage (752 tests)

core 197 · ui 167 · llm-connectors 61 · skill-manifest 56 · modelpilot 46 ·
adapter-linux 42 · adapter-cec 37 · adapter-aosp 28 · cli 21 · acceptance 20 ·
perception-mock 14 · adapter-tizen 14 · skills-example 13 · adapter-webos 10 ·
platform-api 8 · adapter-titan 7 · adapter-xumo 6 · adapter-web 5.

## What has been verified on a device, and what it cost

Every bring-up so far has found defects that no test here could have found, all
of the same shape: **code that only executes when a real counterpart is on the
other end**. That is the argument for the whole verification design, so it is
recorded rather than summarised.

- **Android TV 34 emulator** (first run): the ES-module bundle could never load
  from `file://`; Android's cleartext policy blocked every call to a local model;
  three more. Later, in goal mode: quantised volume made a successful write read
  as a failure, and the world believed a request over a reading.
- **Samsung Tizen TV 10.0 emulator**: `webapis` was never loaded, so nothing
  under it could work; launch flags never reached `location.search`; the profile
  signed with the wrong certificate; the adapter answered confident constants
  where it should have measured. The "broken NAT" diagnosis was itself wrong —
  `config.xml` declared no `<access>` origin, so the app could reach no host at
  all.
- **webOS 26 Simulator** (first run): the app shipped no `webOSTV.js`, so every
  capability threw `ReferenceError`.
- **Voice on Android**: the voice key never reached the WebView (`onKeyDown` is
  not called when a view has consumed the key), and the first reply was never
  spoken because `TextToSpeech` binds in ~3 s while the offline brain answers
  instantly.

Results, and the platform quirks that are *not* bugs, live in
[`platform/capability-matrix.md`](platform/capability-matrix.md) — the Hearth
Report.

## Remaining — needs external resources

1. **A real HDMI-CEC bus (roadmap task 7).** The transport, the discovery source,
   the mock bus and a `cec-ctl` implementation for Linux are built and tested;
   what none of that proves is that any of it works on hardware. A Raspberry Pi
   with `/dev/cec0` and `v4l-utils` is the whole shopping list, and
   `node tools/verify-cec.mjs` prints a transcript ready to paste back as a
   fixture. Android's CEC API is `@SystemApi`; Tizen and webOS expose none.
2. **Phase 2 device bring-up (critical path).** MTK + NVT boards (Tizen + AOSP),
   `?diag`, fill the capability matrix, obtain signing (partner on Tizen,
   platform on Android) for the gated controls.
3. **Tizen audio on a retail TV.** The emulator exposes neither audio API, so
   `volume` and `mute` have never executed on that platform. A retail TV in
   Developer Mode is also where Samsung's `webapis` exists, so it settles the
   rest of that surface at once.
4. **Blits → default UI.** Needs WebGL rendering and perf validated on the
   weakest target GPU before it can replace the DOM fallback.
5. **On-device model benchmark.** Model size vs. RAM/latency on real silicon;
   finalise the cloud/on-device routing policy. The known floor so far: 1.5B
   drives single tools but cannot chain them.
6. **npm publish.** Waiting on the `@hearthkit` npm organisation.

## How to run

```bash
pnpm install && pnpm build && pnpm test    # verify
pnpm dev                                   # browser demo (offline harness)
pnpm bundle:bringup                        # AOSP bundle with ?diag and ?demo in it
pnpm bundle:all                            # default device bundles
pnpm bench                                 # agent-loop latency + planning cost
pnpm package:tizen                         # signed .wgt   (needs tizen-core `tz`)
pnpm package:webos                         # .ipk          (needs @webos-tools/cli)
cd apps/aosp-app && ./gradlew :app:assembleDebug   # Android host (JDK 17+, SDK)
```

On a connected Android device or emulator:

```bash
node tools/mock-llm-server.mjs &           # offline brain over HTTP
adb reverse tcp:8080 tcp:8080
node tools/device-acceptance.mjs           # the CI acceptance script, on the device
node tools/device-report.mjs               # → docs/platform/reports/<target>.md
```
