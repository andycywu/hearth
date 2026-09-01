# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **HDMI-CEC, the first transport past the television** (`packages/adapter-cec`,
  [docs/cec.md](docs/cec.md), roadmap task 7). Everything until now reached
  exactly one device, where "did it work?" is answered by asking the object that
  just did it. A console on HDMI2 has its own power state, its own name, and its
  own ways of ignoring you — so it is the first real test of the claim this
  runtime is built on.
  - A **message-shaped `CecTransport`**: six methods, each named after the CEC
    message it sends. `wake()` resolving means the *bus accepted*
    `<Set Stream Path>` and nothing more; an interface that called itself
    `turnOn(): Promise<void>` would invite exactly the reading this project
    exists to refuse.
  - An **`hdmi_cec` discovery source** that derives the HDMI port *and the parent
    hop* from the physical address — `3.1.0.0` is on port 1 of the device at
    `3.0.0.0`, which is how an AVR with a console behind it announces itself, and
    it is the `parentId` the Device Graph has had a field for since before
    anything could fill it. Devices are identified by physical address, not
    logical: logical addresses are reallocated when devices come and go, and a
    console that is address 4 today can be 8 tomorrow. The logical address is
    used for the type only where the spec is unambiguous (0 is a TV, 5 is an
    audio system) — a playback device stays `unknown`, because a console, a
    Blu-ray player and a streaming stick all take a playback slot and which one
    depends on who plugged in first.
  - **Power that can finally be verified.** `<Give Device Power Status>` is the
    first read that can speak for a device other than the TV, so the writes
    verify by read-back against it. The four outcomes then come from the
    hardware: the console says `on` → `verified`; it woke and never answers →
    `unverified`; the bus accepted the message and it stayed asleep → `failed`;
    there is no CEC here → `unsupported`, withdrawn, never offered again. One
    goal, one plan, four buses, all four pinned by name.
  - **A mock bus that misbehaves on purpose**, following `perception-mock`: a
    device that never answers the power question, one that accepts
    `<Set Stream Path>` and stays in standby, and a platform with no bus at all.
    A mock that only behaves well is a mock that agrees with you.
  - `discoverRoom(platform, { sources })` lets a host wire a transport in without
    core learning what a CEC bus is.
  - **No real CEC bus has run any of this.** The Android API is `@SystemApi`,
    Tizen and webOS expose none, so an absent transport is the *normal* case.
- **A Linux CEC transport over `cec-ctl`** (`createLinuxCecTransport`), which is
  the only implementation of `CecTransport` a person can verify without a signing
  agreement: a Raspberry Pi has `/dev/cec0` and `apt install v4l-utils`. It
  follows the same shape as that adapter's audio backends — every shell call
  through an injectable `Runner`, pure parsers testable without hardware. Two
  operational facts are encoded because they cost time otherwise: an adapter must
  **claim a logical address** before it can transmit at all (a fresh `/dev/cec0`
  has none, and every `--to` fails with "Device has no logical address"), so the
  first transmit configures once and `configure: false` exists for a box where
  another daemon owns the adapter; and **CEC is slow**, so the runner waits 15
  seconds rather than the 5 that is generous for `pactl`. A NACK is a failure and
  not a device that happens to be off — nothing answered at that address.
- **`tools/verify-cec.mjs`**, because the parsers are tested against fixtures
  written from `cec-ctl`'s documentation rather than recorded from a device, and
  the repo says which of those it is. On a machine with an adapter it scans,
  reads power status, runs the discovery source, optionally wakes a device with
  `--writes` and puts it back, and prints the raw output beside what the parser
  made of it plus a transcript ready to paste in as a fixture. It reports how
  many devices answer `<Give Device Power Status>` at all, since *only those can
  ever report `verified`* for a power change. With no adapter it says which of
  the three reasons applies and exits 0 — not owning a Pi is not a test failure.

- **`?cec=mock` in the dev harness**, so the living-room story is visible in a
  browser rather than only in tests: a console, an AVR and a streaming box behind
  that AVR, *discovered* rather than declared, and 「我要打 PS5」 then wakes the
  console over the bus, verifies it with a power-status read-back and switches
  the TV to the port the graph says it is on. It is named `mock` out loud,
  because a demo quietly pretending to be hardware would be the exact dishonesty
  this runtime exists to refuse. The AVR in it never answers
  `<Give Device Power Status>`, so the `unverified` answer is reachable too.
- **`AgentOptions.capabilities`** — the extension point `tools` was missing a
  half of. A tool is what the *model* may ask for; a capability is what the
  *planner* may reason about, with its preconditions, risk level and
  verification. A transport that registered only tools would be invisible to goal
  mode, and one that registered only capabilities would produce a plan nothing
  can execute.
- **`cecTargets(graph, found)`** joins what CEC saw to what the room already
  believes, keyed by the **Device Graph node id** rather than the CEC address. A
  console someone registered by hand is `ps5`; CEC knows it as `2.0.0.0`; a skill
  resolving 「我要打 PS5」 looks for the former. Registering capabilities under the
  address would produce a plan for a device the goal has never heard of — every
  step correct, the whole thing useless.
- **`DeviceTransport`, and a host wires one in a line.** Reaching devices past
  the television was six steps in the right order — build a source, pass it to
  `discoverRoom`, scan again, join what was found to what the room calls things,
  build capabilities, build tools — and the dev harness had all six inline. That
  is exactly how three app hosts came to have three divergent boot sequences, the
  fix for which was `@hearthkit/host`; repeating the mistake one layer up was not
  interesting. So `bootRuntime({ …, transports: () => [createCecTransport(bus)] })`
  is the whole integration, and `?cec=mock` in the harness runs the identical
  path so the two cannot drift.
  - The seam is deliberately **not CEC-shaped**: a transport offers discovery
    sources *before* the room is built, then is handed the merged graph and asked
    what it can now do — because the answer depends on what was found and on what
    the merge decided to call it. IR, Wake-on-LAN and Matter need that same order.
  - Whether a transport exists is a *host* question, not a runtime one: the same
    Android build has CEC or does not depending on how it was signed. A transport
    that throws is dropped with a note in the boot log, because a CEC adapter that
    is not there must never stop a television from booting — and not being there
    is the normal case.
  - It costs **~0.7 KB** on every television that has no transport at all, which
    is the honest price of the seam existing and is stated rather than rounded
    away.

### Fixed

Five defects in code that was already green, all found by CEC being the first
thing that reaches past the television — and all correct for every device that
had existed until now:

- **A parent link could point at a node that no longer existed.** The CEC source
  named a device's parent by the id *it* would have given it, and the graph then
  merged that parent into a node someone had registered by hand under a different
  id — leaving the child pointing at nothing. `inputPortFor` walks that chain to
  answer "which input shows this device", so an Apple TV behind an AVR silently
  had no port. Parents are now named by a strong key (`parentCecAddress`) and
  resolved by `DeviceGraph.linkParents()` after a discovery pass, when every node
  has settled. An unresolvable link stays pending rather than being written as a
  dangling id: the parent may be a switch that does not speak CEC, and it may
  also just be next in the list.
- **The agent told you the TV had done something another device did.** "Asked the
  TV to `ps5.power.on`" was safe to hard-code while every capability was the
  television acting on itself; the TV is the thing that *sent* the message. The
  outcome summary now names the device the steps are actually about, and says
  "I can't" rather than "This TV can't" when the step was not about the TV. A
  plan touching several devices gets a sentence with no subject rather than a
  wrong one.

- **A read-back could verify against its own assumption.** The executor's
  `read_back` branch checked that the verifying read *succeeded*, not that it
  *answered*, while the step's optimistic write was already sitting on that path.
  Every reader in this repo always answers — a TV that reports its volume at all
  reports a number — so the case had never arisen. Over CEC, a device that
  acknowledges `<Give Device Power Status>` and says nothing is ordinary, and the
  result would have been a confident `verified` for a console that never woke:
  the worst answer this system can give. It now checks the backing source,
  exactly as `state` verification already did.
- **Two devices on one HDMI port merged into one.** Device identity fell back to
  the HDMI port, and an AVR at `3.0.0.0` and the box plugged into it at
  `3.1.0.0` are both "on HDMI3" — so the room silently lost a device. The
  identity rule already named the CEC address; nothing stored it. `DeviceNode`
  now carries `cecAddress`, `match()` uses it ahead of the port, and the stored
  source carries it back through persistence so the room does not re-merge them
  on every boot.
- **Two CEC devices could not coexist.** Core names a device-power tool after its
  *provider*, so a second CEC device also wanted to be `cec_power_on`, and the
  registry throws on a duplicate name — a boot crash in any living room with a
  console and a set-top box. Tool names are per device now.

## [0.2.0] - 2026-08-28

The living-room tier: the runtime stopped being a chat loop with tools attached
and became an agent with a model of the room, a plan, a policy and a read-back.
It also acquired a name — **Hearth** — and a size budget.

### Added

- **The project is called Hearth, and its namespaces are `hearthkit`.**
  `tv-ai-agent` was a description, not a name: it could not be searched for and
  it generated no vocabulary for the ideas here. Every globally-unique namespace
  is `hearthkit` (the only candidate free on npm, GitHub and the domain at once);
  the repository is `andycywu/hearth`, because *Hearth* is the product and
  `@hearthkit/*` is where its packages live. Storage prefixes changed from
  `tv-ai-agent` to `hearth`, which breaks continuity once — history, installed
  skills and the saved device graph under the old prefix become invisible.
  Pre-release is the only moment that is free. Deliberately **not** renamed: the
  Android / Tizen / webOS application ids, because an app id is an installed
  identity and changing it invalidates every documented `adb` line.
  [ADR-0003](docs/adr/0003-name-and-namespace.md) records the availability checks
  and the runners-up. The GitHub Pages demo URL is now
  `andycywu.github.io/hearth/`; GitHub redirects a renamed repo's own URLs but
  **not** its Pages site, so the old link is dead rather than forwarded.
- **Build profiles — optional code is removed at build time, not skipped at
  runtime** (`core/src/features.ts`, `tools/bundle.mjs`). A television parses the
  whole bundle on every single launch, on a launcher's memory budget, so "ship it
  and branch around it" is not free there. `--full` / `--with` / `--without` fold
  six features out through `esbuild` `define`, taking everything they import with
  them — measured on the ModelPilot planner: 17.4 KB → 0.1 KB. Three profiles:
  **74 KB** minimal, **95 KB** default, **121 KB** `--full` (adds `?diag`, the
  offline brain, the keyboard and `?demo` — **use it for bring-up**). Installable
  packages, measured rather than estimated: `.wgt` 92.6 KB, `.ipk` 41.9 KB.
  `bundle-features.test.ts` builds the real entry and weighs it, so a regression
  is a failing test rather than a fatter download.
- **`@hearthkit/host` — one boot sequence for all four hosts**, replacing four
  copies that had drifted apart in the ways copies do. A fifth host now
  implements an adapter, not a boot.
- **Planning cost is counted** (`core/src/planner/meter.ts`). Every plan carries a
  `source` — `deterministic`, `model`, `remote`, or `local-fallback` for a remote
  engine that was asked and could not answer — and `agent.planning` counts them
  beside chat turns, which are never free. The ratio between the two decides
  whether goal mode is a product or a demo, and it had never been measured.
  First result, from `pnpm bench`: **the four P0 scenarios plan for 100% zero
  tokens**, 1.7 ms average, no model call at all. Counters are local and read by
  `pnpm bench` and the device report; they are sent nowhere.
- **`tools/device-report.mjs` — one command turns a television into a pasteable
  report.** It launches the app in goal mode, runs the capability probe with
  writes, puts the four P0 scenarios through the planner, and writes a finished
  markdown section into `docs/platform/reports/`. The formatting happens *on the
  device*, by the same code every host ships, so a report taken by hand from a
  WebView console — `(await window.__hearthReport({allowWrites: true})).markdown`
  — is byte-identical to one the tool collects. A platform with no `adb` is not a
  second-class contributor. The section that earns it is the one no adapter can
  produce about itself: **did anything accept a command and then do nothing?**
- **Install identity and service metrics** (`core/src/identity.ts`,
  [`docs/service-metrics.md`](docs/service-metrics.md)). A service business has to
  know how many devices use it; this repo had already promised the runtime does
  not phone home. Both hold, because ModelPilot is the only egress and a host
  opts into it with a credential: three headers ride along on calls that were
  already happening (`x-hearth-install`, `x-hearth-runtime`, `x-hearth-mode`) and
  the rest is derived server-side. No analytics client, no event queue, no second
  endpoint. In `off` mode no signal exists at all. The id is random, generated on
  the device, stored locally and resettable — not the Android ID, not a serial,
  not a MAC, not an advertising id; two identical televisions in the same shop
  get different ids and a test asserts it.
- **A Living Room agent runtime under the chat loop.** The agent kept no state
  between tool calls, could not describe the room it was in, and reported every
  action as a success whether or not the TV did it. Six additive modules in
  `packages/core/src` change that: a **World Model** (facts with source,
  confidence and decay), a **Capability Graph** (what can be done here, with what
  risk, verified how), a **Device Graph** (what is in the room, and on which
  port), a **Planner** with a verification loop, a **Policy engine**, and
  declarative **skills**. Docs: `docs/architecture.md` and the seven design
  documents beside it.
- **Goal mode.** `agent.pursue(goal)` and `agent.pursueSkill(id, params)` run
  plan → policy → execute → verify, beside the existing chat path and sharing its
  world, tools, policy and confirm handler. `plan:start` / `plan:step` /
  `plan:end` reach every renderer through the shared view-model. In the dev
  harness, `?plan=off` forces the chat path so the difference is visible.
- **`policy:decision` events**, so "why did the TV do that?" — and "why did it
  refuse?" — are answerable after the fact.
- **The room persists.** Device topology is stored in `platform.storage`
  (`registerDevice` / `saveDevices` / `forgetDevice`), a `platform` discovery
  source reports what the TV itself can see, and `?devices` prints the tree with
  its confidence and sources visible. Power state deliberately does not persist.
- **ModelPilot integration, first stage** (`packages/modelpilot`). Planning and
  reasoning can go to the ModelPilot execution decision engine; device control
  does not. It plugs in as a third `Planner` behind the existing seam, so the
  tool layer, the HAL and every adapter are untouched, and a returned plan is
  rebuilt through the local Capability Graph — preconditions, verification and
  fallbacks come from the television, never from the answer. Three modes
  (`off` / `shadow` / `enforce`, default `shadow`, forced `off` with no API key),
  an allowlist-based room-state minimiser, typed errors with an explicit fallback
  policy, and telemetry that structurally cannot carry a key, a prompt or a room.
  See [modelpilot-integration.md](docs/modelpilot-integration.md) and
  [ADR-0004](docs/adr/0004-modelpilot-boundary.md).
- **A perception path with no camera in it.** `PerceptionManager` gates sensors:
  nothing starts without a policy grant, every event is stripped of raw capture
  and identity fields (frames, data URLs, transcripts, face embeddings) before it
  reaches the world model or a prompt, and revoking a grant discards events even
  from a source that ignores `stop()`. `packages/perception-mock` proves it end
  to end with a scripted occupancy source and a deliberately misbehaving one.
  `?perception=mock` in the dev harness, with a visible sensor indicator.
- **An LLM planner, validated against the Capability Graph.** The model proposes
  capability ids and arguments only; preconditions, effects, verification and
  fallbacks come from the graph, and five checks reject a bad proposal before
  anything runs — with the reasons kept on `Plan.rejections`.
  `agent.pursueIntent(text)` routes: known skill, else model plan, else
  conversation. Opt-in via `llmPlanning`.
- **Titan OS and Xumo adapter stubs** (`packages/adapter-titan`,
  `packages/adapter-xumo`): the shape of the platform bridge each needs, with
  typed `unsupported` until a real one is wired up — no invented API names. Both
  pass the provider contract and join the acceptance run, which now covers six
  targets. Adding them touched no file under
  `core/src/{world,planner,capabilities,devices,policy}`, which was the point.

### Changed

- **The provider contract checks coherence, not privilege.** It required volume,
  mute and an app list to *work*, which quietly defined a conforming adapter as
  one running on a fully-privileged TV — while the Tizen emulator (no audio API at
  all) and an app-level Xumo build are smaller adapters, not broken ones. Now
  either the group round-trips or every call in it refuses with a typed
  `unsupported`. Still forbidden: a read that answers beside a write that
  silently does nothing.
- **Tools are generated from the capability catalogue.** The tool list was
  written by hand and described by the catalogue afterwards; now the capability
  owns the name, description, schema and risk, and `tv-tools.ts` keeps only the
  platform calls. `ToolSpec.confirm` is derived from `riskLevel`, so the two can
  no longer drift. The model-facing vocabulary is unchanged — `packages/acceptance`
  passes untouched.
- **Switching input is `medium` risk**, which is what its `confirm: true` always
  meant: it takes the screen away from whoever is watching.
- **The capability probe no longer identifies tools by their names.** Which
  capabilities a read speaks for is a `vouchesFor` field on the read capability.
  `CapabilityProbe.withdrawn` is capability ids now, with tool names under
  `tools` and per-id `reasons`.
- **With no confirm handler, a step needing confirmation is declined** rather
  than run. An agent with nobody to ask should not take the screen away. Hosts
  that genuinely have no user pass `unattended: true`. Every host in this repo
  already supplies a handler, so nothing shipped changes.

### Security

- **The API key could end up on the television.** The `?debug` status line
  printed the launch query verbatim, so launching with `?key=sk-…` put a live
  credential on screen — and on a shipped TV that key is the same for every unit
  of the model, so one photograph is everyone's key and everyone's bill. Nothing
  redacted it. `redactSecrets()` now masks `key`, `token`, `secret`, `password`
  and friends wherever the flags are shown, and the runtime warns once when a key
  arrives through the URL at all, because that URL also lives in shell history
  and in the launch intent. Verified on the emulator: the line now reads
  `key=***`.
  - Deliberately not masked: `keyboard`, `monkey` and anything else that merely
    contains a secret-ish word. Hiding a real flag would make the line useless
    for the thing it exists for.
- **Two ways to keep the key off the launch URL**, both optional:
  - `adb shell am start -e llmKey sk-…` provisions it once into the AOSP host's
    keystore (AES-GCM, key held by Android; no new dependency). The extra is
    removed from the intent as soon as it's read, and only its *length* is
    logged. This keeps the key out of the URL, the history, the logs, the screen
    and the APK — but not out of the app, since the page is what calls the model.
    `LlmSecrets.kt` states that boundary next to the code rather than letting it
    be assumed.
  - `examples/llm-relay` holds the key on a server you run, so it is never on the
    TV at all — the only arrangement that survives a device in someone else's
    hands. ~100 lines, streams straight through so tool calling and token-by-token
    replies keep working. Verified end to end: the emulator drove a full turn
    through it with no key on the device.
  - `docs/on-device-inference.md` now lays out all four options weakest-first,
    including what the relay's shared token does *not* buy you.

### Changed

Architecture review pass — three small changes, no restructuring:

- **Every TV tool answers in one shape.** `{ ok: true, data? }` or
  `{ ok: false, error: "unsupported" | "failed" | "offline", message }`.
  Previously "this TV can't do that" was a thrown `Error` whose message began
  with `"Not supported: "` — a convention **nothing parsed at runtime**; only the
  adapter tests asserted it. The agent flattened any tool error to
  `{ error: "<english prose>" }`, so unsupported, failed and offline were
  indistinguishable to the model, which is the difference between "stop asking"
  and "worth a retry". Adapters were **not** changed — they still throw, and the
  classification happens once at the tool boundary, so the working AOSP path was
  untouched.
  - **Adapters now throw `TvUnsupportedError`** rather than a plain `Error` whose
    message starts with `"Not supported: "`. Classifying on that prefix worked
    and was one typo from silently not working: rewording it to `"Unsupported:"`
    compiles, reviews fine, and quietly downgrades the result from *unsupported*
    to *failed* — so the viewer is told "try again" about something that never
    can. The prefix match survives as a fallback for adapters written outside
    this repo, documented as best-effort. Verified on the emulator: asking to
    switch input now answers "This TV can't do that: setInputSource (needs a
    platform signature on most builds)".
  - The offline scripted brain had to learn to pair a result with its call id to
    tell a reader's answer from a mutator's confirmation. It had been inferring
    that from the payload's shape, which only worked because mutators happened to
    carry `ok` and readers didn't.
- **`hasCapability()` in platform-api.** All four adapters had the same `has()`
  line copied in with their own `as any`; the cast now lives in one place with a
  reason next to it.
- **`detectSpeechEngines()` moved from core to platform-api.** It names Samsung's
  and Android's globals, and the agent core must not know what a Samsung is.
  platform-api is already the layer that touches platform surfaces. Left as a
  global probe rather than hidden behind `PlatformProvider.voice`, deliberately:
  the useful answer is what the firmware could support *whether or not* an
  adapter wired voice up.
- **The "one vocabulary" rule is now a test**, not a convention: no tool name may
  contain an OS, the core vocabulary must be byte-identical across web / Tizen /
  AOSP / webOS, and any tool that varies must be capability-gated. Writing it
  caught that the sets already differ — by exactly the four `media_*` tools,
  which is the intended capability gating and not an OS leak.

It no longer looks like a test build. The screen used to open on an engineering
status line, a grey disc and a line of grey hint text, and every surface had
picked its own colours:

- **One theme for all four hosts** (`applyTvTheme`), replacing four stylesheets
  that had drifted apart. The palette, the font stack and the glass treatment are
  tokens now, so the keyboard, the dialog and the avatar can't invent their own
  blue.
- **The window is translucent on AOSP** — the agent appears *over* what you were
  watching and dims it rather than replacing it. That needed the native side: a
  translucent Activity theme and a cleared WebView background, because a WebView
  paints opaque by default. The canvas also stopped filling itself with opaque
  black, which was what made an overlay impossible however translucent the window
  was. `?solid` for a bring-up capture, `?scrim=0.4` to see more of the channel.
  - **Translucency is opt-in per host, and only AOSP opts in.** It was the
    default at first, and that was wrong on two hosts out of three: Tizen and
    webOS give a web app no way to make its window see-through, so the page
    composited its scrim over the web runtime's own pale backing and the whole
    screen came out washed-out grey. Caught on the Tizen emulator, not reasoned
    about. `?translucent` forces it on where you want to try.
  - CSS cannot blur another native window — `backdrop-filter` only ever sees the
    page's own content — so dimming is the only tool there is, and the default
    scrim is heavier than it looks like it should be. At the first value tried the
    launcher behind made the greeting genuinely hard to read.
- **The avatar is the default renderer.** The plain DOM overlay is still there
  for bring-up as `?render=overlay`, which is the right way round.
- **The engineering line is behind `?debug`**, along with the raw tool call the
  avatar used to print along the bottom edge. Both earned their place during
  bring-up — the flags line is how the Tizen launch-flag fault was found — but
  neither is something a viewer should be reading.
- **A greeting instead of an empty screen**, drawn on the canvas so it disappears
  the instant there is a real reply, and a phase pill that says "Listening…" in
  words rather than only in colour and motion.
- **An on-screen Speak button**, because "press the voice button on your remote"
  was the only way in and is untrue on any remote without that key — and on the
  Android TV emulator, which has no remote at all, so the only way to start
  listening was `adb shell input keyevent 84`. OK did nothing on that screen at
  all. It now accepts OK/Enter, a pointer click and the remote's voice key, all
  four verified to open the microphone on the emulator. The hint text names a
  control that exists.
- **Confirmations ask in plain words**: "Switch the TV input to HDMI 1?" instead
  of `Allow set_input_source(source=hdmi1)?`. That was the one place the
  engineering face had real consequences — the safe answer to a question you
  don't understand is always No. Any argument the sentence doesn't name is still
  appended, because a gate that hides what it is asking about is worse than an
  ugly one.

### Fixed

- **A recognition attempt that produced no transcript left the app listening
  forever.** `VoicePipeline` had no way to say "the attempt is over": the only
  signal was a transcript, and `startListening()` resolves as soon as the request
  is handed to the platform, not when the attempt ends. So a no-match, silence or
  an error closed the microphone while the avatar kept pulsing — and the shell's
  own listening flag stayed set, which made every later press a no-op. Voice was
  dead until the app was relaunched, and since you can't get a transcript without
  speaking, this was the first thing anyone would hit. `onListeningEnd` is now
  part of the contract, wired to the AOSP bridge's `stopped` event (which was
  being received and discarded) and to `recognition.onend` in the shared Web
  Speech pipeline, so Tizen and webOS were affected identically. There's a 30 s
  backstop as well, because nothing here is worse than being stuck.
  - Confirmed on the Tizen emulator over the Web Inspector: `startListening()`
    resolves successfully and no transcript ever arrives, which is exactly the
    case the old code read as "still listening". `onListeningEnd` fires once.
- **Press again to give up.** The button was inert for the whole attempt, which is
  the wrong answer to "it isn't hearing me".

Voice on AOSP, which didn't work at all on a device despite passing every test:

- **The voice button did nothing.** The forwarding added in `5b8557e` overrode
  `Activity.onKeyDown`, which Android calls only when no view has consumed the
  key — the focused WebView consumes everything, so it never ran. Intercepting in
  `dispatchKeyEvent`, which sees the event before any view, is what actually
  works. BACK was unaffected because it arrives via `onBackPressed`.
- **The first reply was never spoken.** `TextToSpeech` takes ~3s to bind and the
  offline model answers instantly, so the greeting hit an engine that wasn't
  ready yet and was dropped on the floor. Warming up at launch narrowed that
  window but never closed it; the engine now holds one pending utterance and
  speaks it on init. A failed init releases it, so the avatar can't get stuck
  mid-sentence.

### Build, CI and dependencies

- **TypeScript 6.0.3, ESLint 10.9.1, typescript-eslint 8.68, esbuild 0.28** —
  verified rather than trusted, because two are major versions and one is the
  tool the whole size story rests on. esbuild was re-measured: **97.3 / 94.5 /
  97.2 KB, byte-identical to 0.23**. ESLint was checked to be actually linting
  rather than quietly finding nothing (`--format json` → 156 files, 0 problems),
  which is the failure mode a config-discovery change in a major produces.
  GitHub Actions bumped to current majors; `action-gh-release` only runs on a
  tag, so this release is its first exercise.
- **`tools/secrets-check.mjs`** — a credential tripwire over changed files,
  wired into CI.
- **`check:size` now bundles the targets it checks.** A webos budget was added
  while `bundle:all` still built only tizen and aosp, so the check was looking
  for a bundle nobody had built.
- **The pipewire CI leg waits for the daemon it is about to use.** It waited on
  WirePlumber and then called `pactl`, whose socket belongs to a third daemon —
  so whether the null sink existed came down to a race, which is why the fix
  looked like a fix and then like a regression. Readiness is a property of the
  thing you are about to use, not of the thing that happens to be nearby.
- **`tools/mock-modelpilot-server.mjs` exits after 15 idle minutes**
  (`--idle <seconds>`). Five abandoned instances, days old, once made the
  repository directory itself un-renameable — each holds a working-directory
  handle on the repo root. A fixture that outlives its test is not harmless.

### Documentation

- **The README says what this is and what it is not**, on the first screen:
  an experimental open runtime and a testbed, not a TV OS, a launcher or a
  content product, and affiliated with nobody. The finding that shaped it is
  stated rather than buried — on every OS whose image we do not own, the flagship
  scenario is **refused**, because input switching needs a platform signature on
  Android and a partner certificate on Tizen and webOS.
- **[The Hearth Report](docs/platform/capability-matrix.md) is promoted from an
  internal note to the project's main output.** No company can buy twenty
  televisions across five firmware generations, and no amount of further software
  produces that table — only people with different TVs in different living rooms
  can. So the highest-value contribution here needs no code: run `?diag` on a
  television nobody here owns and paste what it said.
- **CONTRIBUTING gains support tiers, a refusal list and a review promise** —
  what will not be accepted (content search, telemetry, vendor blobs, guessed
  platform APIs, anything widening the perception boundary), because a short firm
  list attracts the right people and saves an argument.
- **[`HARDWARE_VERIFICATION.md`](docs/HARDWARE_VERIFICATION.md) covers the room,
  not just the TV** — grouped by what you would have to physically obtain, since
  "needs hardware" on its own is not actionable.
- **STATUS, the roadmap and the internal handoff were rewritten against the
  code.** All three had drifted: two different wrong test counts, no mention of
  ModelPilot, `@hearthkit/host`, build profiles or the device report, and a
  handoff still describing a `tv-ai-agent` repo with 163 tests. A project whose
  entire premise is not claiming things it hasn't verified cannot ship a stale
  status page.

## [0.1.0] - 2026-08-05

First release. The `0.1.0` heading below was written in July but never tagged —
no release was ever published — so this one carries everything, and the original
notes are kept as *Foundations* rather than pretending there was a version in
between.

### Added

You can talk to it:

- **A real confirmation dialog**, replacing `window.confirm`. That placeholder
  blocks the JS thread, isn't reliably focusable with a D-pad, and is stubbed out
  on some TV builds — which silently turned the confirmation gate into "always
  approve". The replacement is a 10-foot modal driven by the same remote intents
  as the keyboard, and it becomes the default wherever there's a DOM.
- It defaults to **No**, and Back declines whatever is focused: the gate exists to
  stop side effects the viewer didn't ask for, so a stray OK shouldn't launch
  anything. There's a timeout too, because a modal nobody dismisses is worse on a
  TV — there may be no pointer.
- Two defects only a device could show, both fixed. Android routes the hardware
  BACK key to the *Activity*, not into the WebView as a key event, so pressing it
  closed the whole app instead of declining; the page now exposes
  `window.__tvBack` and `MainActivity` asks it first. And the dialog stayed on
  screen after being answered, because an inline `display:flex` beats the user
  agent's `[hidden] { display: none }`.
- Verified on the Android TV emulator both ways: approving ran `launch_app` and
  YouTube came up; declining left the agent reporting "Action declined by the
  user" with the dialog gone.

- **CJK input, with an honest split.** The keyboard now switches layouts
  (`?keyboard=phrases` opens on one directly). Japanese gets a **real kana
  keyboard** — kana are text, so a grid is enough and no IME is involved.
  Chinese gets **ready-made phrases**, because characters cannot be typed from a
  grid: that needs an IME with a dictionary, phonetic input and a candidate list,
  which is a large component to own and miserable to drive with four arrow keys.
  A phrase list is what Netflix and YouTube already do for TV search, and it
  doubles as discoverability. A test asserts this design so nobody later "fixes"
  it into a broken half-IME.
- Verified on the Android TV emulator by picking 音量調到 30 with the remote and
  pressing Send: `?diag` afterwards read `getVolume ✅ 33` — the Chinese phrase
  reached `AudioManager` (33 rather than 30 because Android quantises volume,
  which the capability matrix already documents).

- **Voice on Tizen and webOS, with no native code** — and this corrects an
  assumption. I expected Samsung voice to need Bixby and a partner agreement; the
  TV 10.0 emulator instead reports `speechSynthesis (TTS, 4 voices),
  webkitSpeechRecognition (STT)`, because the Tizen WebView is Chromium. Both
  adapters now use a shared `createWebSpeechPipeline()` — the implementation the
  web adapter already had, moved into `platform-api` rather than copied a third
  time. Tizen went from `voice ⚠` to `voice ✅ advertised`, and `?diag` reports
  zero unsupported capabilities there.
- `?diag` gained a **`voice.engines`** row listing which speech APIs a given
  firmware actually has, including the synthesis voice count — an engine with
  zero voices is silently mute and otherwise looks identical to a working one.
  Being honest about the limit: `webkitSpeechRecognition` *existing* is not it
  *working*, since Chromium ships audio to a cloud service and that emulator has
  no network. webOS is wired the same way but remains untested.
- **Voice on Android TV** — `TextToSpeech` and `SpeechRecognizer` through the
  native bridge, exposed as the HAL's existing `VoicePipeline`. Android first
  because both are public SDK: TTS needs no permission at all and recognition
  needs RECORD_AUDIO, an ordinary runtime permission the user grants from a
  dialog. No platform signature, no vendor agreement — which is not true of
  Samsung's or LG's voice stacks.
- The mic key only appears when the platform actually has a pipeline, and voice
  shares the keyboard's field, so a transcript can be corrected before it's sent
  and both input methods live in one place on screen.
- Verified on the Android TV emulator: pressing 🎤 Speak drove the permission
  dialog, and once granted logcat shows `RecognitionService#onMicrophoneOpened`
  for `callingApp: tv.aiagent.harness` with the avatar in its listening state and
  Android's own green microphone indicator lit — the OS confirming the mic is
  open rather than our code claiming it.

- **An on-screen keyboard a remote can drive** (`?keyboard`). Until now the
  device hosts had no input surface at all — they said so on screen — so a TV
  could only run whatever was baked into the launch flags. Now it can be typed
  to. Written here rather than delegating to each platform's IME, because that
  route is capability-gated per vendor and needs a focused input the WebView may
  not get; a grid of divs works identically on all four hosts with no privileges.
- The navigation is `createKeyboardModel()`, pure and tested (27 tests). The
  interesting part is ragged rows: it remembers the column you *aimed* for across
  a short row, because without that the cursor creeps left every time you pass a
  gap and the whole thing feels broken on a remote.
- Verified on the Android TV emulator by driving it with real D-pad key events:
  typed "mute" letter by letter, pressed Send, and `?diag` afterwards reported
  `getMute ✅ true`. The word went from the remote through the agent to
  `AudioManager`.

An avatar:

- **`mountAgentAvatar()` — the agent has a face.** An abstract form drawn in
  code: no artwork to license or download, sharp from 720p to 4K, and a handful
  of arcs is cheap enough for the weakest MTK/NVT GPU. Four states that read from
  across a room — still when idle, rings travelling outward when listening,
  turning inward when thinking, wobbling when speaking. `?render=avatar` on any
  host, verified on the Android TV emulator.
- The motion is `avatarFrame()`, a **pure function** of phase and time, so it is
  unit-tested without a canvas and can be reused by the WebGL renderer later.
  It self-drives when speaking rather than requiring an audio envelope, because
  Tizen and webOS both hand playback to the platform and may never expose one.
  Honours `prefers-reduced-motion`, where the phases stay distinguishable by
  colour and shape rather than movement.
- The view-model now derives a single `phase` (idle / listening / thinking /
  speaking) so no renderer has to re-derive it. Listening outranks everything,
  including mid-turn: an open microphone changes what the viewer does, and that
  is a privacy signal as much as a UI state.

The device hosts run offline:

- **`?demo` no longer needs a network on a TV.** The offline scripted brain was
  already in every bundle, but the Tizen, AOSP and webOS hosts always built an
  HTTP client against a hardcoded `http://127.0.0.1:8080/v1`, so a freshly
  installed app on a TV whose network isn't set up yet — or on an emulator image
  whose NAT is broken — could not run the demo it ships with. With no `?llm=`
  configured they now fall back to the scripted brain, and the status line says
  `llm=offline` so nobody mistakes it for a real model. `?llm=` still wins, so
  bring-up against a real endpoint is unchanged.
- Verified end-to-end on **both** emulators with no network at all: the Tizen TV
  emulator ran all eight demo commands and `?diag` afterwards read
  `getVolume ✅ 50`, the value the demo's Japanese step set — so the offline
  agent parsed 音量を50にして and changed real device state through the HAL.
  Android did the same and answered 現在音量多少? with the device's own volume.
  The Android acceptance script still PASSes against the HTTP path.

Skills as data:

- **`@hearthkit/skill-manifest`** — a skill can now be a JSON document the
  runtime interprets rather than TypeScript it loads: a schema the model chooses
  on, one HTTP request whose `{placeholders}` come from validated arguments, and
  paths that reduce the response. That keeps the app's "no remote code" property
  intact while making a skill installable onto a TV that already shipped, and
  reviewable by someone who doesn't read TypeScript. Two sources, both offline:
  `loadBundledSkills` for manifests in the app bundle and `loadInstalledSkills`
  for ones written into `platform.storage`. There is deliberately no third — the
  runtime never fetches a skill on its own.
- The trust model is the interesting part, and it's argued in
  [ADR-0002](docs/adr/0002-declarative-skill-manifests.md): the **host** owns the
  origin allowlist and a manifest cannot widen it or put a placeholder in its own
  host; no manifest-supplied headers, so a skill can't attach someone else's
  credentials; https or loopback only; only declared parameters interpolate;
  non-GET forces confirmation whatever the manifest says; the response mapping is
  paths, not expressions, so there's no evaluator to escape and no route to the
  prototype chain. Unknown fields are rejected rather than ignored, so a typo
  can't quietly disable one of those. 56 tests, most of them asserting a refusal.
- A worked example, [`open-meteo-weather.json`](packages/skill-manifest/examples/open-meteo-weather.json),
  wired into the dev harness as `?skills=manifest` — the same capability as the
  hand-written `?skills=weather` skill, for comparison. The offline brain answers
  it from a small coordinate table and says so when a city isn't in it: a
  manifest makes one request, so it can't geocode first. That limit is real and
  worth seeing rather than hiding.

Device bring-up (Phase 2 tooling):
- **webOS `.ipk` packaging** — `pnpm package:webos` (`tools/package-webos.mjs`).
  Works around two `ares-package` behaviours: it minifies with an old uglify-js
  that can't parse our ES2020 bundle (`-n`, a flag missing from `--help`), and it
  packages the whole app directory, which in a pnpm workspace meant shipping the
  linked `node_modules` tree, the TS source and the sourcemap — 290 KB became
  34 KB with excludes.
- **First run against a real local model** (Qwen2.5-1.5B-Instruct Q4 via
  `llama-server`, reached from the emulator through `adb reverse`): tool calls
  reach `AudioManager` and change device state, but the model skips the chained
  steps (read-then-write, search-then-launch). Measured and tabulated in
  `docs/on-device-inference.md` — **tool *chaining* is what sets the model floor**,
  and 1.5B is below it. `tools/device-acceptance.mjs` now prints a diagnosis
  separating "the platform is broken" from "the model is weak", which is the
  distinction that run made concrete.
- **Tizen packaging moved to `tizen-core` (`tz`)** — Tizen Studio is EOL and the
  toolchain is now the Tizen VS Code extension. `pnpm package:tizen`
  (`tools/package-tizen.mjs`) bundles, builds and signs a `.wgt` in one command,
  with `--flags` to bake `?demo` / `?diag` / `?llm=` into the start page (Tizen
  has no equivalent of Android's `-e start`). Docs updated across
  `EMULATOR_SETUP`, `POC`, `BRINGUP_CHECKLIST`, `RELEASING`,
  `platform/tizen-bringup` and the app README.
- Documented the three Tizen certificate tiers, after an earlier claim here that
  **no Samsung account was needed** turned out to be wrong: a locally generated
  `tz cert` is enough to *build* a signed `.wgt`, but a Samsung TV (including its
  emulator) rejects it at install with `Operation not allowed : :Load archive
  info fail` — that needs a **Samsung** certificate from Certificate Manager
  (free account). A Samsung *partner* certificate remains a third tier, needed
  only for the privileged capabilities the POC defers.
- **App icon** (`pnpm icon`, `tools/make-icon.mjs`): both `config.xml` (Tizen) and
  `appinfo.json` (webOS) referenced an `icon.png` that didn't exist, which breaks
  packaging on both. Drawn in code — no image dependencies — so it can be
  regenerated at any size.
- `resolveLlmEndpoint()` — one precedence rule (`?llm=`/`?model=`/`?key=` → window
  globals → default) shared by all four hosts, so a **shipped** `.wgt`/APK/`.ipk`
  can be repointed at another model by relaunching with a query string instead of
  being rebuilt. The docs already promised `?llm=` on device; now it works.
- `tools/mock-llm-server.mjs` — serves the offline scripted brain as an
  OpenAI-compatible endpoint, so an on-device run uses the exact decisions the CI
  acceptance test asserts (`adb reverse` keeps it inside the app's CSP).
- `tools/device-acceptance.mjs` — runs the `packages/acceptance` script against a
  real/emulated Android device over the Chrome DevTools Protocol and compares the
  tool sequence and end state to the CI baseline. No dependencies; no manual typing.
- `?confirm=auto|deny` bring-up override (`confirmOverrideFromUrl`), logged loudly,
  so an automated run isn't blocked on a native dialog.
- `?diag` now also prints the report to the console, so bring-up can copy it off
  the device (`adb logcat -s chromium:I`, Web Inspector, `ares-inspect`) instead of
  reading a screenshot.
- Hosts expose `window.__tvPlatform` alongside `window.__tvAgent` so a device run
  can assert real device state.
- Custom tool extension point (`AgentOptions.tools`, `defineTool`) and a built-in
  `help` tool.
- Conversation persistence via `platform.storage` (`persistKey` + `restore()`).
- Confirmation gate for high-impact tools (`ToolSpec.confirm`, `AgentOptions.confirm`);
  `set_input_source` and `launch_app` are confirm-required by default.
- Multilingual replies: system prompt answers in the user's language; the offline
  scripted brain replies bilingually (English/Traditional Chinese).
- webOS app host (`apps/webos-app`, `.ipk`); dev-harness `?diag` view + transcript.
- Optional wake-word support in `VoicePipeline` (`startWakeWord`/`stopWakeWord`),
  implemented in the web adapter; hands-free toggle in the dev harness.
- API reference (`docs/api.md`).
- Single-surface **canvas renderer** (`mountAgentCanvas`) reusing the agent event
  wiring, plus a pure `wrapLines` helper (Latin + CJK); dev-harness `?render=canvas`.
- Standalone **Lightning 3 / Blits (WebGL)** demo (`apps/blits-demo`) — same event
  wiring, GPU-rendered; excluded from the workspace/CI (its own install).
- **Cross-target acceptance test** (`packages/acceptance`): one command script runs
  identically on web / Tizen / AOSP / webOS (mocked), asserting the same tool
  sequence and end state — hardware-free Phase 2 proof.
- LLM connector **retry/backoff** for transient failures (network / 5xx / 429).
- Gradle wrapper (8.7) for `apps/aosp-app` so the Android host builds with one
  command; the debug APK now compiles against the Android SDK.
- Shared, DOM-free **agent view-model** (`createAgentViewModel`) in
  `@hearthkit/ui` — one tested reducer over the agent events, consumed by all
  three renderers (DOM overlay, 2D canvas, Blits WebGL), so a new view layer only
  implements `draw`. Blits is now a first-class renderer without adding Vite or
  Blits to `packages/*`.

- `pnpm bench` (`tools/bench.mjs`): p50/p95 per-turn latency of the agent loop
  over the acceptance script, with the offline brain — i.e. harness overhead with
  no model or network noise. README badges (CI / license / Node).
- Japanese replies and intents in the offline scripted brain (`ja`): kana-first
  language detection, verb-final app opening ("Netflix を開いて"), ミュート /
  解除, relative volume, and a `{0}`-template phrase table so the next locale is
  a data edit.
- Non-blocking CI job that builds `apps/blits-demo`, so the WebGL renderer can't
  silently rot while staying out of the workspace toolchain.
- **Skill authoring guide** (`docs/skills.md`): pure-logic vs capability-gated
  skills, why that split decides whether a vendor signature is needed, and the
  rules a portable skill follows.
- **Example skill** `packages/skills-example` — `get_weather` over the keyless
  Open-Meteo API (timeout, flat result, model-readable errors), 13 tests with a
  fake `fetch`. Opt-in in the dev harness via `?skills=weather`.
- The offline scripted brain is now capability-aware: it reads the registered
  tool list and only proposes a custom skill's tool when the host registered it,
  so `?skills=weather` works with no model at all.
- `createConfirmHandler()` and `speakReplies()` in `@hearthkit/ui`, and all
  three device hosts (Tizen / AOSP / webOS) now use them: high-impact tools are
  gated before they fire on a real TV, and replies are spoken where the platform
  advertises voice. The dev harness uses the same two helpers, so "parity with
  the harness" is now shared code rather than a copy per host.
- Test coverage raised from 54 to 105: TV tool behaviour and media capability
  gating, diagnostics write/restore and navigation-readiness paths, AOSP
  accessibility gating, webOS Luna mapping, OpenAI request/message mapping, and
  web-adapter state/`has()` semantics.

Making it usable by someone who didn't write it:
- **`npm create tv-agent-skill <name>`** (`packages/create-skill`, also
  `pnpm new:skill`) — scaffolds a skill package whose tests already pass, so the
  first run is green rather than a compile error. `--http` generates the
  fetch variant with the two things a TV skill needs and a server-side one
  doesn't: an `AbortController` timeout and tests with `fetch` mocked. Inside the
  monorepo it lands in `packages/` and links by `workspace:*`; outside it's
  standalone. 8 tests of its own.
- **`pnpm doctor`** (`tools/doctor.mjs`) — checks Node, pnpm, whether the lockfile
  still covers every workspace package, the Android SDK / TV image / AVD /
  emulator acceleration, the Gradle wrapper, the Tizen signing profile and
  emulator VMs, and the webOS CLI; prints the one command that fixes each gap.
  Every check is there because it cost someone time. Platform tooling you don't
  need reports as "not set up" rather than failing.
- **Every device host now renders something.** `mountDeviceShell()` puts the agent
  overlay plus a status line on screen for AOSP / Tizen / webOS, which previously
  created an agent and showed a blank screen — no reply, tool call or error ever
  reached the display.
- **`?ask=…` (repeatable)** runs commands at startup, so a TV with no keyboard and
  no voice wiring can still be driven — by a launch command, a demo, or bring-up.
  Verified on the emulator, including a Chinese command.
- **Hosted demo**: a GitHub Pages workflow publishes the dev harness, so the
  runtime can be tried with no install, no API key and no TV.
- **`?demo` — a self-running demo on any host.** Eight commands (absolute and
  relative volume, a read-back, an app query, the same intents in Chinese and
  Japanese, mute→unmute so the TV is left as found), each shown on screen as
  `▶ … (4/8)` while it runs; `?demo=loop` for an unattended screen. It needs no
  model — point it at `tools/mock-llm-server.mjs`. Verified end to end on the
  Android TV emulator, driving `AudioManager` through 33 → 40 → 53.

### Changed
- `mountAgentOverlay` / `mountAgentCanvas` render the shared view-model instead
  of each subscribing to the agent bus themselves; public signatures and visual
  behaviour unchanged.
- **README rewritten for people who don't already know the project**, and the
  internal working notes (`HANDOFF.md`, task specs) moved to `docs/internal/` so
  the front page isn't someone else's to-do list.
- **Dropped the TitanOS naming.** The project is independent, so the app identity
  is now `tv.aiagent.harness` (Android package + Kotlin source tree, webOS app id;
  the Tizen widget URI is `https://aiagent.tv/harness`, its `tvaiagent` package id
  unchanged), the webOS vendor is `TV AI Agent`, and `LICENSE`/`NOTICE` read
  `Copyright 2026 TV AI Agent contributors`. Docs that framed privileged signing
  as "TitanOS-owned devices" now say "devices you own" / "a platform vendor",
  which is what was actually meant. Done before publishing on purpose: an app id
  is the installed identity, so changing it later would orphan installs.

### Fixed
- **`platform.storage` never persisted anything, on any platform.** All four
  adapters backed it with an in-memory `Map` (AOSP with a Kotlin `HashMap`), so
  `Agent`'s `persistKey` — whose entire promise is that a conversation survives
  an app reload — silently lost everything on restart. Nothing errored; the data
  just wasn't there. Now: `SharedPreferences` on AOSP, `tizen.preference` (with a
  localStorage then memory fallback) on Tizen, `localStorage` on webOS and web.
  The existing test couldn't catch it because it reused one adapter instance;
  the new one builds a second adapter, which is what a restart actually is.
- **AOSP: the runtime never started on a device.** `index.html` loads `main.js` as
  an ES module, and module scripts are CORS-blocked from `file://` (null origin),
  so the WebView only ever showed the placeholder page. Assets are now served
  through `WebViewAssetLoader` on a virtual origin.
- **AOSP: no request to a local model could succeed.** Android blocks cleartext
  http from targetSdk 28, so every call to an on-device model server failed with a
  bare "Failed to fetch". Added `network_security_config.xml` permitting cleartext
  for loopback only (not app-wide). The app origin is http for the same reason:
  WebView, unlike desktop Chrome, does not exempt localhost from mixed-content
  blocking, and `MIXED_CONTENT_COMPATIBILITY_MODE` still blocks fetch/XHR.
- **AOSP: relaunching with new flags did nothing.** `am start` on a running app
  didn't redeliver the intent, so `?diag` / `?llm=` were ignored; the activity is
  now `singleTop` and reloads in `onNewIntent`. This also avoids `force-stop`,
  which makes Android drop the app from the enabled-accessibility list and thereby
  disables navigation.
- **AOSP: "not supported" reasons were lost across the bridge.** Android replaces
  anything thrown inside a `@JavascriptInterface` method with a generic "Java
  exception was raised during method invocation", so a merely-unavailable
  capability was reported as a hard **error** in bring-up. The adapter now supplies
  the reason (and points at the accessibility-service setup where relevant).
- AOSP: `list_apps` could report the same app twice — one package can expose
  several launcher activities, and the agent identifies apps by package, so the
  model saw duplicates. Deduped in the bridge.
- **AOSP: volume drifted.** The 0-100 ↔ device-steps conversion truncated in both
  directions, biasing every value down and compounding across relative
  adjustments; it now rounds.
- AOSP: the WebView had no `WebChromeClient`, so `window.confirm()` was silently
  cancelled — every confirm-required tool (switch input, launch app) looked as if
  a user had declined it without ever being asked. The host now shows a real,
  remote-focusable `AlertDialog` for JS confirm/alert.
- AOSP host crashed on launch: `AppCompatActivity` had no `Theme.AppCompat`
  theme. Added `Theme.TvAiAgent` (no action bar, black window background).
- `createAospAdapter()` threw a bare `ReferenceError: TvNativeBridge is not
  defined` instead of its own "are you running inside the AOSP host WebView?"
  message — the guard was unreachable because the global was read directly.
  It now reads the bridge off `globalThis`.
- AOSP `list_apps` / `launch_app` returned almost nothing on API 30+: added the
  `<queries>` launcher-intent declarations required by package visibility
  (instead of `QUERY_ALL_PACKAGES`).
- Refreshed `pnpm-lock.yaml`: it predated `apps/webos-app`, `apps/dev-harness`
  and `packages/acceptance`, so CI's `pnpm install --frozen-lockfile` would have
  failed.

### Security
- WebView hardening on AOSP (`MainActivity`: file-access flags, in-origin
  navigation) and a `Content-Security-Policy` `<meta>` in every app `index.html`.

### Foundations

The core as it stood on 2026-07-27, before device bring-up.

- Portable agent core ("the Harness"): agent loop, tool registry, LLM
  abstraction, rolling memory, typed event bus.
- Platform HAL (`@hearthkit/platform-api`) with adapters for Tizen, AOSP
  (WebView native bridge) and web/mock, verified by a shared contract test.
- Tool set: volume, mute, input source, list/search/launch apps, key navigation,
  media transport (auto-registered when `has("media")`).
- Streaming responses (`completeStream` + `token` events) and an offline
  scripted brain (`createScriptedClient`) with relative-volume commands.
- Browser **dev harness** (`pnpm dev`) with the UI overlay, Web Speech voice, and
  configurable LLM endpoint via `?llm=`/`?model=`.
- On-device capability **self-diagnostic** (`runDiagnostics`, `?diag`) and a
  capability matrix workflow.
- Android **AccessibilityService** navigation path (no special signing) and
  best-effort input switching via the TV Input Framework.
- Build/test tooling: esbuild bundler, bundle-size budget, ESLint flat config,
  CI (build → typecheck → lint → test → bundle → size), Apache-2.0, docs.

### Notes
- Advanced controls (system-wide input switch, standby, raw key injection) require
  a partner/platform certificate (Tizen) or system signature (Android); the
  open-source build degrades gracefully via `has()`.

[0.2.0]: https://github.com/andycywu/hearth/releases/tag/v0.2.0
[0.1.0]: https://github.com/andycywu/hearth/releases/tag/v0.1.0
