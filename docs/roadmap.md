# Roadmap

The product is an **AI Agent Runtime / cross-OS agent control plane for smart TVs
and living-room devices** — not a TV OS, and not a voice assistant. A TV OS is
one execution environment among several, reached through an adapter.

What we are **not** building: content search, a recommendation engine, another
launcher. Titan OS and Xumo already do those well, and Xumo's universal search
and voice control in particular are more mature than anything we would write.
Those become tool providers.

What we **are** building, because nothing on the market has it:

1. Living Room World Model
2. Device discovery and a Device Graph
3. Capability discovery and a Capability Graph
4. Multi-device reasoning
5. Multi-step autonomous action
6. Camera / microphone perception
7. Cross-OS abstraction
8. Agent tool execution
9. Action verification
10. Permission, safety and policy control

This roadmap supersedes the OS/SoC-shaped plan in
[`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md), which remains accurate about
platform bring-up, signing and privilege levels — that work is still real and
still needed, it is just no longer the top-level story.

---

## Where we are

Shipped and verified (see [`STATUS.md`](STATUS.md)): the agent loop, the HAL and
five adapters under one contract test, tool registry with validation, the
`TvResult` envelope, boot capability probing with capability withdrawal, voice,
four renderers, declarative skills, packaging for Android TV / Tizen / webOS,
**724 tests green**. Goal mode is verified on the Android TV emulator, not only
in CI.

The state and reasoning tier (M0, additive — nothing existing was modified):

| Module | Purpose |
|---|---|
| `core/src/world/` | `WorldModel`, `Fact`, reconciliation, decay, prompt summary |
| `core/src/capabilities/` | `Capability`, `CapabilityGraph`, the TV capability catalogue |
| `core/src/devices/` | `DeviceGraph`, `DiscoverySource`, manual + platform sources |
| `core/src/perception/` | `PerceptionEvent` and the reducer into world state |
| `core/src/planner/` | `Goal`, `Plan`, `GoalPlanner`, `PlanExecutor`, verification |
| `core/src/policy/` | `PolicyEngine`, risk levels, default and parental rules |
| `core/src/skills/` | `gaming_session`, `movie_night`, `night_mode`, `quieter` |

All four P0 scenarios pass headless in
[`scenarios.test.ts`](../packages/core/src/planner/scenarios.test.ts).

Landed since, and not otherwise described by any plan document here:

| | What it is | Why it is on this roadmap at all |
|---|---|---|
| `packages/modelpilot` | Planning and reasoning can go to the **ModelPilot** execution decision engine, as a third `Planner` behind the seam tasks 4 and 9 created. `off` / `shadow` / `enforce`, `shadow` by default, forced `off` with no credential | It is the answer to "who plans?" when the local model is too small — and it is where the boundary gets tested: a remote engine cannot name a capability this TV lacks, cannot weaken a check, and **cannot mark its own work as verified**. The local read-back keeps the last word in every mode. [ADR-0004](adr/0004-modelpilot-boundary.md) |
| `core/src/planner/meter.ts` | Every plan carries a `source` — `deterministic`, `model`, `remote`, `local-fallback` — and `agent.planning` counts them | The ratio between a free plan and a paid one decides whether goal mode is a product or a demo, and nobody had counted it. First measurement: **the four P0 scenarios plan for 100% zero tokens**, 1.7 ms average |
| `core/src/identity.ts` + [`service-metrics.md`](service-metrics.md) | A random, local, resettable install id, sent only where a ModelPilot call was already going | A service has to count installs; this runtime promised not to phone home. Both hold, because the count happens server-side on calls the host opted into |
| `core/src/features.ts` | Optional code removed at **build** time by `esbuild` `define` — 74 / 95 / 121 KB for the three profiles | A TV parses the whole bundle on every launch. "Ship it and skip it at runtime" is not free there |
| `packages/host` | One boot sequence for all four hosts | Four copies had drifted; the fifth host would have made it five |
| `tools/device-report.mjs` | One command turns a television into a pasteable markdown section of [the Hearth Report](platform/capability-matrix.md) | The report is the project's main output, and every manual step between a stranger's TV and that table is a place the report does not get sent |

---

## P0 — goal-based agency on one platform

**Platform:** Android TV emulator + mock adapter. Nothing else.

**Loop:** Intent → World Model → Capability Graph → Planner → Tool execution →
Verification → World Model.

**Scenarios**

| | Utterance | The point |
|---|---|---|
| A | 「切到 HDMI2」 | chosen from the graph, and **verified** by a read-back |
| B | 「我要打 PS5」 | goal, multi-step, port derived from the Device Graph |
| C | 「我要看電影」 | content reached as a tool, never as core logic |
| D | 「小聲一點」 | relative intent resolved against world state, no re-read |

**Exit criteria**

- ✅ The four scenarios run on the Android TV emulator, not only in CI —
  verified 2026-08-18, results and the two defects it found in
  [`capability-matrix.md`](platform/capability-matrix.md).
- Every executed step reports `verified`, `unverified` or `failed` — never an
  assumption dressed up as success.
- Moving the PS5 to another HDMI port changes the plan and changes no code.
- Withdrawn capabilities never reach the model, and `?diag` says why.
- ✅ `packages/acceptance` gains a plan-level scenario suite —
  [`plan-acceptance.test.ts`](../packages/acceptance/src/plan-acceptance.test.ts),
  six targets. The **plan** is identical everywhere; the outcome is honest per
  platform, and pinned by name so it cannot quietly become "verified".

**Explicitly out of P0:** CEC, IR, real hardware, camera, IoT, Titan, Xumo, Roku.

---

## P1 — the real living room

- HDMI-CEC transport: device discovery, power, active-source, OSD names.
  *Built and mock-tested (task 7); needs a platform transport and a real bus.*
- IR blaster profiles for devices with no back channel.
- Real Android TV hardware bring-up (MTK / NVT boards).
- Device discovery populating the Device Graph from CEC + manual registration.
- Multi-provider capabilities (`ps5.power.on` over CEC / WoL / IR) with
  demotion on failure.
- AVR and set-top-box paths, including the parent-hop through an AVR.
- Microphone in the loop: wake word to intent to plan.
- End-to-end: **User → Agent → TV → PS5 → AVR**, verified at each hop.

---

## P2 — perception and the wider room

- Camera and microphone perception sources behind an explicit policy grant.
- Vision: occupancy, presence, ambient light. Derived events only; raw frames
  never leave the perception layer.
- Context-aware behaviour: kids present, room dark, nobody watching.
- IoT via Matter and Home Assistant as capability providers.
- World Model persistence across reboots, with decay applied on restore.

---

## P3 — the other operating systems

Connectors, not core. Each is an adapter plus a contract test.

- Titan OS adapter
- Xumo adapter
- webOS adapter (promote the existing one from experimental)
- Tizen adapter (already implemented; needs retail-TV verification)
- Roku adapter (ECP)

The measure of success is unchanged: adding one of these must not touch
`planner`, `world`, `capabilities`, `devices`, `policy`, `memory` or the agent
core.

---

## Next 10 implementation tasks

Ordered. Each is independently shippable.

### 1. Generate tools from the Capability Graph — **done**

- **Goal** — one source of truth for what the agent can do. `createTvTools`
  becomes a projection of `createTvCapabilities`.
- **Files** — `core/src/tools/tv-tools.ts`, `core/src/capabilities/tv-capabilities.ts`,
  new `core/src/capabilities/to-tools.ts`, `core/src/agent/agent.ts`.
- **Dependencies** — none (M0 is in).
- **Acceptance** — `packages/acceptance` passes unchanged; the tool list is
  byte-identical to today's; adding a capability adds a tool with no other edit.
- **Risk** — medium: this is the LLM-facing surface, and a changed description
  changes model behaviour.
- **Complexity** — M (1–2 days).
- **Outcome** — `capabilities/to-tools.ts` projects specs; `tv-tools.ts` is
  handlers only; `confirm` derives from `riskLevel`. Two behaviour changes fell
  out and were kept: switching input is `medium` (it takes the screen away from
  whoever is watching, which is what the old `confirm: true` already meant), and
  the planner now refuses a capability whose required arguments the goal cannot
  supply — it was picking `content.play` over `content.resume` for a goal that
  said nothing about what to play.

### 2. Wire the World Model into the agent loop — **done**

- **Goal** — every `tool:result` becomes an observation; a world summary is
  injected into the system prompt.
- **Files** — `core/src/agent/agent.ts`, `core/src/world/from-tools.ts`,
  `core/src/memory/context.ts`.
- **Dependencies** — task 1 (needs capability↔tool identity).
- **Acceptance** — after "set volume to 30", a following "what's the volume?"
  answers from state with no second `get_volume` call; prompt growth stays under
  600 characters.
- **Risk** — medium: prompt changes affect every turn; stale facts must be
  marked, not asserted.
- **Complexity** — M.
- **Outcome** — `Agent.world` is a `WorldModel`; every tool result is read into
  it through its capability's `reads` map, so it arrives on every adapter with no
  adapter change. Known facts go into the system prompt under a character budget,
  and only known ones — an empty world adds nothing. The stated acceptance
  ("answers with no second `get_volume`") turned out not to be testable from
  here: whether the model re-reads is the model's decision, and the scripted
  brain always re-reads. What is asserted instead is what this layer actually
  controls — the agent knows, and the prompt says so.

### 3. Replace the probe's name-matching with capability withdrawal — **done**

- **Goal** — delete `reasonFor()`'s `name.includes("volume")` guesswork; the
  probe withdraws *capabilities*, and tools follow.
- **Files** — `core/src/tools/capability-probe.ts`, `core/src/agent/agent.ts`,
  `core/src/capabilities/graph.ts`.
- **Dependencies** — tasks 1, 2.
- **Acceptance** — on the Tizen emulator (no audio API) volume and mute
  capabilities are withdrawn with the probe's own note, and `?diag` shows the
  reason per capability.
- **Risk** — low. Existing withdrawal tests cover the behaviour.
- **Complexity** — S.
- **Outcome** — which capabilities a read speaks for is now a `vouchesFor` field
  on the read capability, next to the read, instead of a table in the probe and a
  `name.includes("volume")` guess in the agent. `Agent.capabilities` is a live
  `CapabilityGraph`: the probe withdraws capability ids and the tools follow, and
  a call-time `unsupported` withdraws the capability too. `CapabilityProbe` now
  returns `withdrawn` (ids), `tools`, `notes` and `reasons` — the one breaking
  change, and hosts only ever read `notes`.

### 4. Plan-mode entry point on the agent — **done**

- **Goal** — `agent.pursue(goal)` runs planner → policy → executor → world, next
  to the existing chat path. A skill trigger routes to it.
- **Files** — `core/src/agent/agent.ts`, `core/src/planner/*`, `apps/dev-harness/src/main.ts`.
- **Dependencies** — task 2.
- **Acceptance** — the four P0 scenarios run through the dev harness UI; plan
  steps stream to the overlay as they execute; free-form chat is unaffected.
- **Risk** — medium: two execution paths must not diverge in policy or events.
- **Complexity** — L (3–5 days).
- **Outcome** — `agent.pursue(goal)` / `agent.pursueSkill(id, params)`, sharing
  the world, tools, policy and confirm handler with the chat path. `plan:start`
  / `plan:step` / `plan:end` reach every renderer through the existing
  view-model, so the avatar and both canvases show plan steps with no renderer
  change. A skill can now `resolve` its parameters against the room — and
  decline, which is reported as `blocked` rather than as a failed plan, because
  "I don't know where your PS5 is" needs a different answer from "I tried and it
  didn't take". Two scenarios came out honest rather than tidy: on a platform
  with no CEC, waking the console is `unreachable` and the plan says so instead
  of pretending; and `switch_input` with no port named falls through to chat so
  the model can ask which input rather than the agent picking one.

### 5. Policy engine replaces the boolean confirm gate — **done**

- **Goal** — `ToolSpec.confirm` becomes `Capability.riskLevel`; the host confirm
  handler becomes the `ask` outcome; every decision is audited.
- **Files** — `core/src/policy/policy.ts`, `core/src/agent/agent.ts`,
  `core/src/tools/registry.ts`, `packages/ui/src/device-ux.ts`.
- **Dependencies** — task 1.
- **Acceptance** — the existing confirm-dialog tests pass against the engine;
  a denial reaches the user with its rule id; `?confirm=auto` still works for
  device bring-up.
- **Risk** — low, and it removes a duplicated gate.
- **Complexity** — M.
- **Outcome** — one `gate()` for both paths, decisions driven by `riskLevel`,
  every decision emitted as `policy:decision` for the audit trail. Tools outside
  the catalogue get a stand-in capability instead of a free pass. Behaviour
  change, deliberate and documented: no confirm handler now means *decline*, not
  *run anyway* — `unattended: true` is how a bring-up script asks for the old
  behaviour, and it had to be added to three test harnesses that were relying on
  it silently.

### 6. Device Graph in the host, plus a `?devices` diagnostic — **done**

- **Goal** — hosts build a Device Graph at boot (platform + manual sources) and
  persist it; `?devices` renders the tree.
- **Files** — `core/src/devices/*`, new `core/src/devices/platform-source.ts`,
  `apps/dev-harness/src/main.ts`, `apps/cli/src/main.ts`, `packages/ui/`.
- **Dependencies** — none.
- **Acceptance** — a manually registered PS5 survives a reload; Scenario B runs
  on the Android TV emulator against the persisted graph.
- **Risk** — low.
- **Complexity** — M.
- **Outcome** — `saveDevices` / `loadDevices` / `registerDevice` / `forgetDevice`
  over `platform.storage`, a `platform` discovery source, `deviceTreeText`, and
  `?devices` in the dev harness. A corrupt record is skipped rather than fatal.
  One real defect surfaced: the graph's merge preferred the *incoming*
  observation per field, so the platform's low-confidence "Device on HDMI2" would
  rename a hand-registered PlayStation 5. Merging now prefers the better
  evidence, and `unknown` never overwrites a known type.
  **Verified on the emulator** (2026-08-18): the seeded room persisted and the
  platform source merged into it — `PlayStation 5 [ps5] — HDMI2 · 100% · manual`
  beside `AOSP TV on x86 [tv] — built in · 100% · manual+platform`.

### 7. HDMI-CEC discovery and control adapter — **software done; hardware pending**

- **Goal** — first real transport beyond the HAL: enumerate CEC devices, read
  power state, wake, set active source.
- **Files** — new `packages/adapter-cec/`, `apps/aosp-app/**` (native bridge
  additions), `core/src/devices/types.ts`.
- **Dependencies** — task 6.
- **Acceptance** — on real hardware, a CEC-discovered console appears in the
  graph with vendor and physical address, and `ps5.power.on` reports `verified`
  from a CEC power-status read rather than `unverified`.
- **Risk** — high: CEC is advertised far more often than it works, and Android's
  CEC APIs are privileged on most builds.
- **Complexity** — L, hardware-gated.
- **Outcome so far** — [`packages/adapter-cec`](../packages/adapter-cec): a
  message-shaped `CecTransport` (six methods, each named after the CEC message it
  sends), an `hdmi_cec` discovery source that derives the HDMI port *and the
  parent hop* from the physical address, power capabilities verified by a
  `<Give Device Power Status>` read-back, and a mock bus that misbehaves the way
  real hardware does. 27 tests; the four honest answers are pinned by one goal
  against four buses. Design and rationale: [`cec.md`](cec.md).

  It found three defects in code that was already green, all the same shape —
  correct for every device that had existed until now. **A read-back could verify
  against its own assumption**: the executor checked that the read succeeded, not
  that it *answered*, and every reader in this repo always answers. Over CEC a
  silent-but-successful read is ordinary, and the result would have been a
  confident `verified` for a console that never woke. **Two devices on one HDMI
  port merged into one** — an AVR and the box plugged into it are both "on
  HDMI3", and `cecAddress` was named in the identity rule but never stored.
  **Two CEC devices could not coexist**, because core names a power tool after
  its provider and the registry throws on a duplicate.

  **What is still true: no real CEC bus has run any of this.** The Android API is
  `@SystemApi`, Tizen and webOS expose none, so `available()` returning false is
  the normal case. The cheapest verification anyone can buy is a Raspberry Pi and
  `cec-ctl` — which makes a Linux `CecTransport` the next thing worth writing,
  and the first one an outside contributor could actually finish.

### 8. Perception source interface with a mock camera — **done**

- **Goal** — prove the perception path end to end without a CV model: a mock
  source emits occupancy events behind a policy grant, and the world updates.
- **Files** — `core/src/perception/*`, new `packages/perception-mock/`,
  `core/src/policy/policy.ts`.
- **Dependencies** — task 5 (the grant is a policy decision).
- **Acceptance** — no perception source starts without a grant; raw data never
  appears in the world, the prompt or logs; revoking the grant stops the source
  within one event.
- **Risk** — medium, mostly privacy design rather than code.
- **Complexity** — M.
- **Outcome** — `PerceptionManager` enforces the three properties at the
  boundary: no grant no sensor, raw capture and identity stripped from every
  event, revocation effective before `stop()` is even called.
  `packages/perception-mock` ships a scripted source *and* a deliberately leaky
  one — attaches a frame to every event, ignores `stop()` — because a
  well-behaved source proves nothing. Writing the leaky test tightened the code
  twice: a short `transcript` string sailed through the first sanitiser, and
  `revokeAll` emitted two grant-dropped events for one source.

### 9. LLM planner alongside the deterministic one — **done**

- **Goal** — the model proposes a `Plan` as JSON; it is validated against the
  Capability Graph before anything runs.
- **Files** — new `core/src/planner/llm-planner.ts`, `packages/llm-connectors/`,
  `core/src/planner/types.ts`.
- **Dependencies** — tasks 1, 4.
- **Acceptance** — a plan naming an unknown capability, an unsatisfiable
  precondition or a denied risk level is rejected before execution, with the
  reason surfaced; the deterministic planner still wins for known skills.
- **Risk** — medium: this is where a model gets to compose actions, so
  validation must be total.
- **Complexity** — L.
- **Outcome** — `createLlmPlanner` proposes only capability ids and arguments;
  `buildStep` supplies preconditions, effects, verification and fallbacks from the
  graph, so a model cannot weaken its own checks. Five rejections run before
  execution (unknown/withdrawn capability, schema violation, missing argument,
  false precondition, policy denial), all recorded on `Plan.rejections`.
  `agent.pursueIntent(text)` is the routing rule in one place: known skill, else
  model plan, else `undefined` meaning "this is conversation". Deterministic
  planning still goes first for any goal it can measure.
  A side finding: this turn's harness edit deleted a function that nothing
  typechecked, because four app hosts had `typecheck` stubbed out as an `echo`.
  They are real now, and adding them surfaced a latent bug — three hosts imported
  `@hearthkit/platform-api` without declaring it as a dependency.

### 10. Titan OS and Xumo adapter stubs with contract tests — **done**

- **Goal** — prove the boundary holds. Interface, capability declaration and a
  contract test; **no integration**.
- **Files** — new `packages/adapter-titan/`, `packages/adapter-xumo/`,
  `packages/platform-api/src/contract.ts`, `packages/acceptance/src/mocks.ts`.
- **Dependencies** — tasks 1, 5.
- **Acceptance** — both stubs pass `assertProviderContract` against mocks and
  appear in the cross-target acceptance run; the diff touches no file under
  `core/src/{world,planner,capabilities,devices,policy}`. That last clause is the
  actual test.
- **Risk** — low, and its value is diagnostic: if this task turns out to need a
  core change, the architecture is wrong and we want to know before P3.
- **Complexity** — S.
- **Outcome** — `packages/adapter-titan` and `packages/adapter-xumo`, both
  contract-tested and both in the six-target acceptance run. **The boundary
  held**: no file under `core/src/{world,planner,capabilities,devices,policy}` was
  touched. The stubs declare the bridge they need and refuse with typed
  `unsupported` until one exists, rather than guessing at API names nobody here
  can verify. They also found a real defect one layer down —
  `assertProviderContract` required volume, mute and an app list to *work*, which
  defined a conforming adapter as one on a fully-privileged TV. It now checks
  coherence: round-trip, or refuse consistently. Still forbidden is a read that
  answers beside a write that silently does nothing.

---

## Guardrails

- Keep it small. Every module added here must earn its place with a test.
- No framework. No plugin system, no DI container, no event-sourcing engine.
- The core never learns an OS name.
- `unverified` is never reported as success.
- Content stays a provider.
