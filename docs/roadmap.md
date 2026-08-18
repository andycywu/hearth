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
`TvResult` envelope, boot capability probing with tool withdrawal, voice, three
renderers, declarative skills, packaging for Android TV / Tizen / webOS, 518
tests green.

Added in this change (M0, additive — nothing existing was modified):

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

- The four scenarios run on the Android TV emulator, not only in CI.
- Every executed step reports `verified`, `unverified` or `failed` — never an
  assumption dressed up as success.
- Moving the PS5 to another HDMI port changes the plan and changes no code.
- Withdrawn capabilities never reach the model, and `?diag` says why.
- `packages/acceptance` gains a plan-level scenario suite.

**Explicitly out of P0:** CEC, IR, real hardware, camera, IoT, Titan, Xumo, Roku.

---

## P1 — the real living room

- HDMI-CEC transport: device discovery, power, active-source, OSD names.
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

### 2. Wire the World Model into the agent loop

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

### 3. Replace the probe's name-matching with capability withdrawal

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

### 4. Plan-mode entry point on the agent

- **Goal** — `agent.pursue(goal)` runs planner → policy → executor → world, next
  to the existing chat path. A skill trigger routes to it.
- **Files** — `core/src/agent/agent.ts`, `core/src/planner/*`, `apps/dev-harness/src/main.ts`.
- **Dependencies** — task 2.
- **Acceptance** — the four P0 scenarios run through the dev harness UI; plan
  steps stream to the overlay as they execute; free-form chat is unaffected.
- **Risk** — medium: two execution paths must not diverge in policy or events.
- **Complexity** — L (3–5 days).

### 5. Policy engine replaces the boolean confirm gate

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

### 6. Device Graph in the host, plus a `?devices` diagnostic

- **Goal** — hosts build a Device Graph at boot (platform + manual sources) and
  persist it; `?devices` renders the tree.
- **Files** — `core/src/devices/*`, new `core/src/devices/platform-source.ts`,
  `apps/dev-harness/src/main.ts`, `apps/cli/src/main.ts`, `packages/ui/`.
- **Dependencies** — none.
- **Acceptance** — a manually registered PS5 survives a reload; Scenario B runs
  on the Android TV emulator against the persisted graph.
- **Risk** — low.
- **Complexity** — M.

### 7. HDMI-CEC discovery and control adapter

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

### 8. Perception source interface with a mock camera

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

### 9. LLM planner alongside the deterministic one

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

### 10. Titan OS and Xumo adapter stubs with contract tests

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

---

## Guardrails

- Keep it small. Every module added here must earn its place with a test.
- No framework. No plugin system, no DI container, no event-sourcing engine.
- The core never learns an OS name.
- `unverified` is never reported as success.
- Content stays a provider.
