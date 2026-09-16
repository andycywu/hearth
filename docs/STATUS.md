# Project Status

A snapshot of what is built, what is verified, and by what. For the plan see
[`roadmap.md`](roadmap.md) (product) and [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)
(platform bring-up). For what an emulator structurally cannot answer, see
[`HARDWARE_VERIFICATION.md`](HARDWARE_VERIFICATION.md).

_Last updated: 2026-09-16 · released: v0.1.0 (2026-08-05) · cutting: v0.2.0_

**The honest one-line version: the runtime works, it has run on one real
television — an HKC TTQ55UQ1CS on Tizen 7.0, where the capability probe is clean
and the acceptance script passes — and as of 2026-09-16 it has read one real
HDMI-CEC bus from a Raspberry Pi 3B beside it. Everything else is still
emulators, and nothing has yet reported `verified` for a device that is not the
television itself.**

The agent runs end-to-end on the Android TV and Samsung Tizen emulators and on
the webOS 26 simulator, driven by a real local model, with goal mode — device
graph → plan → policy → execute → verify — proven on the Android TV emulator
through logcat. Packaging is verified for all three hosts (APK / signed `.wgt` /
`.ipk`). One real television has now answered the Tizen half of that — see
below — and what is still unproven is what neither an emulator nor a single TV
has: webOS stubs audio and app management, no Samsung-branded set has run
anything, and CEC, IR, an AVR, a console, a camera and a far-field microphone
need a room rather than a television.

**793 tests green**, across 18 packages.

## At a glance

| Area | State |
|------|-------|
| Agent core (loop, tools, memory, events, streaming) | ✅ done |
| World Model · Capability Graph · Device Graph · planner · verification · policy | ✅ done, wired into the agent loop |
| Goal mode (`agent.pursue`, `pursueSkill`, `pursueIntent`) | ✅ done, beside the chat path and sharing its world, policy and confirm gate |
| LLM planner (model proposes, graph validates) | ✅ done — five rejections run before anything executes |
| ModelPilot planner (remote model router) | ✅ **run against production 2026-09-01** — 12/12 plans parsed, p50 2.9s, ~$0.00017 each, shadow agreed with the deterministic planner, and an enforce pass posted a verdict the service accepted. One tenant, one provider, a mock television; per-device keys and quota still unsolved |
| Planning cost meter (`agent.planning`) | ✅ done — the four P0 scenarios plan for **zero tokens**, 1.7 ms average |
| Perception boundary + mock camera | ✅ done — no grant no sensor, raw capture stripped, revocation beats `stop()` |
| Platform HAL + adapters (web, Tizen, AOSP, webOS, Linux) | ✅ 5 implemented, one shared contract test |
| Titan OS / Xumo adapters | 🟡 stubs: bridge shape + contract test, no integration. Both in the 6-target acceptance run |
| Host boot (`@hearthkit/host`) | ✅ one boot sequence for all four hosts, replacing four divergent copies |
| Build profiles (`--full` / `--with` / `--without`) | ✅ optional code removed at build time, not skipped at runtime — 74 / 95 / 121 KB |
| Install identity + service metrics | ✅ random, local, resettable id on ModelPilot calls only; no analytics endpoint exists |
| Device report (`tools/device-report.mjs`, `tools/device-report-tizen.mjs`) | ✅ one command turns a TV into a pasteable markdown section — adb on Android, the Web Inspector on Tizen |
| LLM connectors (OpenAI-compatible + offline scripted) | ✅ done, with retry |
| UI renderers (avatar, DOM overlay, 2D canvas, Blits WebGL) | ✅ one shared view-model behind all of them |
| Voice (ASR/TTS + wake word) | ✅ Web Speech on web/Tizen/webOS, native bridge on Android, and **ALSA + espeak-ng on Linux, verified on a Pi 3B with a ReSpeaker 4-Mic array 2026-09-16**. Recognition on Linux is an *injected* `Transcriber` — a build without one reports `unsupported` rather than listening to a microphone it cannot understand. No wake word there: that needs an always-on detector, and `VoicePipeline` makes it optional so an adapter can decline instead of imitating one |
| CLI on the device (`apps/cli`) | ✅ same agent loop in a terminal |
| Skills — code and JSON manifests | ✅ guide, runnable example, installable manifests |
| Tests / CI / lint / bundle-size / license / SBOM / secrets gate | ✅ 793 tests, CI green |
| **Android TV emulator bring-up** | ✅ 11 ok / 0 errors, acceptance script passes |
| **Goal mode on the Android TV emulator** | ✅ verified 2026-08-18, two device-only defects found and fixed |
| **Local model driving a real TV** | ✅ on the Android **and** Tizen emulators; 1.5B is too weak to chain tools |
| **Tizen emulator bring-up** | ✅ installs, runs, offline demo runs, real model works |
| **webOS install run** | ✅ runs on the TV 26 Simulator; audio and app management are stubs there |
| **Linux platform** | ✅ all three backends against real tooling — `pactl`/`wpctl` in CI, `amixer` on a real sound card |
| **Tizen audio (volume, mute)** | ✅ **verified on a real TV 2026-09-14** — through the *standard* `tizen.tvaudiocontrol`, whose first execution found `getMute()` missing from it (it is `isMute()`). Still unexercised on Samsung's `webapis.audiocontrol`, which that set does not carry |
| **Tizen on retail hardware** | ✅ HKC TTQ55UQ1CS, Tizen 7.0 — 16 ok / 0 error, acceptance script PASS, installed with a plain `tizen-dev` certificate. [Report](platform/reports/tizen-ttq55uq1cs.md) |
| **HDMI-CEC** | 🟡 **discovery verified on a real bus 2026-09-16** — a Pi 3B on HDMI 3 of the HKC set: adapter answered, `0.0.0.0 · TV` discovered as `tv, internal`, the topology parser agreed with the raw output. Two defects found getting there, one of them on an *empty* bus. Still open: `verified` for a power change needs a **second device** on the bus — the TV is the platform's own, so `0/0` devices answer `<Give Device Power Status>`. [`cec.md`](cec.md) |
| **Real MTK/NVT device bring-up** | 🟡 one licensed NVT-firmware Tizen set is done (above). No Samsung-branded set, no MTK set, no AOSP board |
| **Blits promoted to default UI** | ⛔ needs browser/GPU testing |
| **On-device model benchmark** | ⛔ needs hardware |

## Test coverage (793 tests)

core 197 · ui 167 · llm-connectors 61 · modelpilot 69 · skill-manifest 56 ·
adapter-linux 58 · adapter-cec 37 · adapter-aosp 28 · cli 21 · acceptance 20 ·
perception-mock 14 · adapter-tizen 16 · skills-example 13 · adapter-webos 10 ·
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
- **A real CEC bus** (Pi 3B → HKC TTQ55UQ1CS, 2026-09-16): `cec-ctl` never
  prints the word `NACK` — an unanswered transmit reads `Tx, Not Acknowledged
  (4), Max Retries` and **exits 0** — so the check meant to catch it never fired
  and a message that reached nobody came back as a successful transmit. Found on
  an *empty* bus, before the television's CEC was even switched on. The test
  fixture had been a string ending in `: NACK`, which no version of cec-ctl
  prints: the code and the test agreed with each other, and neither had asked a
  device.
- **HKC TTQ55UQ1CS, Tizen 7.0** (the first real television): `getMute()` does
  not exist on the standard `tizen.tvaudiocontrol` — it is `isMute()` — so the
  one API call that had never run anywhere failed on the set that could answer
  it, and took relative-volume goal mode down with it. Separately, `sdb shell`
  is disabled on a retail set and answers empty output with exit 0, so every
  bring-up command "succeeded" and did nothing until the tooling moved to the
  `0 debug` / `0 vd_applist` verbs.
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
3. **Tizen audio on a *Samsung* TV.** Done on a licensed set (2026-09-14), which
   settled the standard `tizen.tvaudiocontrol` path and found `getMute()` missing
   from it. What that set cannot answer is Samsung's own `webapis.audiocontrol`:
   it carries `webapis` without the audio module, so that branch is still
   unexercised code and will first run on somebody's Samsung-branded television.
4. **Blits → default UI.** Needs WebGL rendering and perf validated on the
   weakest target GPU before it can replace the DOM fallback.
5. **On-device model benchmark.** Model size vs. RAM/latency on real silicon;
   finalise the cloud/on-device routing policy. The known floor so far: 1.5B
   drives single tools but cannot chain them.
6. **ModelPilot on a device, and at more than one tenant.** The integration has
   run against production and the numbers are recorded in
   [`modelpilot-integration.md`](modelpilot-integration.md#measured-against-the-live-service)
   — but on a laptop, against a mock television, with one provider configured.
   Three things are still open, and only the first is code:
   the 429 wall and candidate fallback are unexercised; every latency number
   needs retaking on MTK/NVT, where a WebView, a bridge and a weak radio all add
   to it; and **keys and quota are a shipping blocker** (Free is 1000 requests a
   month *per tenant*, and the install id does not participate in that count, so
   one key across a fleet is one household spending everyone's month).
   [ADR-0004 amendment](adr/0004-modelpilot-boundary.md).
7. **npm publish.** Waiting on the `@hearthkit` npm organisation.

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

On a connected Tizen television (`sdb connect <tv-ip>:26101`) — the same two
answers, over the Web Inspector rather than adb:

```bash
node tools/device-report-tizen.mjs         # → docs/platform/reports/<target>.md
node tools/device-acceptance-tizen.mjs     # the CI acceptance script, on the TV
```
