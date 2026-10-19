# HANDOFF — for whoever picks this up next

_Rewritten 2026-08-28. The previous version described a repo that no longer
exists — 163 tests, a `tv-ai-agent` namespace, and a Group A/B/C/D task list
whose software half finished a month ago. If any file here disagrees with
[`../STATUS.md`](../STATUS.md), STATUS is the one that gets updated._

Read in this order: [`README.md`](../../README.md) (what this is and is not) →
[`STATUS.md`](../STATUS.md) (what is built and verified) →
[`roadmap.md`](../roadmap.md) (what to build next) →
[`PRODUCT_PLAN.md`](../PRODUCT_PLAN.md) (who it is for and in what order) →
[`HARDWARE_VERIFICATION.md`](../HARDWARE_VERIFICATION.md) (why the rest is
blocked on physical objects).

## Where the work is

_Updated 2026-10-19. The software roadmap is finished; M1 (Hearth Hub) is built and mostly measured; what is left is a person
speaking, a stranger installing, and hardware nobody here has._

**Done and verified on a real Pi 3B (ReSpeaker 4-Mic, HDMI 3 of a Titan OS television)**: `sh tools/install.sh` → `hearth`
on PATH; `hearth setup` (remembers the platform, voice, wake word, ModelPilot choice); `hearth report`; CEC discovery and
TV power by text with read-back; the status ring; Lab; the hosted ModelPilot end to end through Hearth's own client
(`hearth modelpilot check` — completion, SSE, tool loop, streamed and not; Gemini needs its `provider_metadata` sent back);
`get_host_status`; shadow planning that does not make anyone wait; `--stream-speech` (first word ~1.5 s sooner, ~0.5 s gap per
sentence — off by default).

**Not done, in this order**

1. **Spoken commands, end to end — none is verified.** Everything that listens has been exercised with files, a robot voice or a
   scripted microphone. The whole list, with commands, expectations and a table to fill in, is
   [`../VOICE_TEST_PLAN.md`](../VOICE_TEST_PLAN.md). Start with V4 (how the transcriber spells "hearth" — it once wrote "Hard"):
   everything else reads as failing if the wake word is wrong. Read `vcgencmd get_throttled` first; it was `0x50000` on
   2026-10-19 (under-voltage since boot, cause unknown).
2. **The boot service.** `setup` writes `hearth.service`; nothing has confirmed it is installed, enabled, or survives a reboot (V16).
3. **On-TV agent UI** — a Chromium kiosk on the Pi's HDMI fed by a local WebSocket from the CLI.
4. **The 15-minute stranger test** — M1's exit condition; needs a stranger and only the README.
5. **Titan OS recon** — private repo, not here ([`../../CLAUDE.md`](../../CLAUDE.md), "Boundaries").
6. **Two-television comparison** — the Pi back on the HKC Tizen set.
7. **Not built, and named so nobody assumes**: wake-word detector, echo cancellation and barge-in, a persistent audio player (removes
   the per-sentence gap), Jev gate / IntentRouter interfaces, a real provider behind the local ModelPilot (it answers with mock models).

**Waiting on someone else:** ModelPilot streaming for `claude-sonnet` and `gemini-flash` (`422 streaming_provider_not_supported`;
only openai models stream), and the hosted service's default reasoning effort (`medium`; `none` measured ~0.9 s faster).

**Blocked on hardware**

| Blocked on | Items |
|---|---|
| A console or AVR on the CEC bus | M2: "switch to the PS5", every step `verified` — a power change needs a second device that answers |
| A retail Samsung TV | Tizen audio via `webapis.audiocontrol` — unexercised code |
| MTK / NVT boards | Phase 2 bring-up, the privileged controls, on-device model benchmarks |
| A browser with a weak GPU | Blits as the default renderer |

## Definition of green

Run before every commit. CI runs the same thing:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm bundle:all && pnpm check:size
```

Currently: **1183 tests**, 19 packages, clean lint.

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

- **`pnpm` must be on PATH, and not via corepack.** Node 26 does not ship
  corepack at all. Worse than missing: a `pnpm` shim left behind by an older
  Node still resolves, runs pnpm on *that* Node, and `engine-strict` then
  refuses the install with `Got: v24` from a shell whose `node --version` says
  26. `npm install -g pnpm@9.12.0` under the Node you actually mean. Nested
  scripts invoke `pnpm` directly, so a top-level-only shim is not enough.
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
