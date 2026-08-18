# Architecture

**The TV AI Agent is not a TV OS.** A TV OS is one of the agent's execution
environments. Content discovery is not the moat — Titan OS, Xumo, Google TV and
the rest already do it well, and we consume it as a tool provider. What is
missing on every one of those platforms, and what this repository builds, is:

> a **Living Room World Model**, a **Capability Graph**, a **Device Graph**,
> **goal-based planning** and **execution verification**, behind an adapter layer
> so no TV OS ever reaches the agent core.

This document is the map: what exists today, where it falls short of that goal,
what the target looks like, and how we get from one to the other without a
rewrite. Companion docs: [world-model](world-model.md),
[capability-graph](capability-graph.md), [device-graph](device-graph.md),
[agent-planner](agent-planner.md), [tool-adapter-design](tool-adapter-design.md),
[policy-and-safety](policy-and-safety.md), [roadmap](roadmap.md).

---

## 1. Current architecture (as of 2026-08-18)

A pnpm/TypeScript monorepo. ~10.7k lines of source, 484 tests, CI green, running
on the Android TV emulator, the Tizen TV emulator and the webOS simulator.

```
apps/*            hosts: AOSP WebView APK, Tizen .wgt, webOS .ipk, dev harness, CLI
  |
packages/ui       DOM / canvas / Blits renderers over one shared view-model
  |
packages/core     Agent loop - ToolRegistry - ConversationContext - EventBus
  |               capability-probe - diagnostics - TvResult envelope
  |
packages/platform-api   the HAL: SystemControl, AppControl, Navigation,
  |                     NetworkInfo, KeyValueStore, MediaControl?, VoicePipeline?
  |                     + assertProviderContract (one behavioural spec)
  |
packages/adapter-{web,aosp,tizen,webos,linux}   concrete HAL implementations
packages/llm-connectors                          OpenAI-compatible + scripted
packages/skill-manifest                          declarative HTTP skills (ADR-0002)
```

Request flow today:

```
user text --> Agent.run()
              |- ConversationContext.add
              |- LlmClient.complete(messages, toolSpecs)
              |- wantsToolCalls? --no--> final answer
              |- policy: spec.confirm && opts.confirm(...)
              |- ToolRegistry.call --> PlatformProvider (HAL) --> OS
              `- append tool result --> loop (max 6 rounds, 30s budget)
```

### What is genuinely good and must be kept

| Asset | Why it survives the repositioning |
|---|---|
| `PlatformProvider` HAL + `assertProviderContract` | Already the OS-adapter boundary the new direction demands. The core never sees `tizen.*` or `adb`. |
| `packages/adapter-*` (5 targets) | webOS/Tizen/AOSP/linux/web already exist; the "adapters, not forks" principle is already load-bearing here. |
| `ToolRegistry` + `validateArgs` | A real security boundary: model output never reaches hardware unvalidated. Becomes the *execution* layer under the planner. |
| `TvResult` envelope (`ok`/`unsupported`/`failed`/`offline`) | The typed distinction verification and replanning need: `unsupported` means withdraw the capability, `failed` means retry is reasonable. |
| `capability-probe.ts` + tool withdrawal | An embryonic Capability Graph: it already asks the device what it can do and revokes what it cannot. |
| `runDiagnostics` | Read-only, write-guarded probing — reusable as a capability and world-model source. |
| `EventBus` (`tool:call`, `tool:result`, `tool:withdrawn`) | The observation stream the World Model subscribes to. |
| `skill-manifest` | Providers as *data*, not code. Exactly the shape a content or IoT provider should have. |
| `packages/acceptance` | Cross-target behavioural parity without hardware. Extends naturally to plan-level scenarios. |
| Confirm gate (`spec.confirm` + host handler) | The seed of the Policy layer; it needs risk levels, not replacement. |

**Conclusion: no rewrite.** The layering is already Core → Tool → Adapter. What
is missing is a *state and reasoning tier* above the tool layer.

---

## 2. Gap analysis

| # | Target capability | Today | Gap |
|---|---|---|---|
| 1 | Living Room World Model | none — the only state is `ConversationContext` (chat history) | No `LivingRoomState`, no confidence/timestamp/source, no reconciliation. The agent re-reads the TV every turn and knows nothing between turns. |
| 2 | Capability Graph | implicit: a flat list of `ToolSpec` + a boot probe | No first-class capability carrying `preconditions`, `sideEffects`, `riskLevel`, `verification`, `provider`, `confidence`. A planner cannot reason about capabilities it cannot see. |
| 3 | Device Graph | none | `InputSource` is a string enum (`hdmi2`). Nothing knows *what is on* HDMI2. No discovery (CEC/mDNS/SSDP/BT/Matter). |
| 4 | Multi-device reasoning | none | Every tool targets "the TV". There is no way to address a PS5 or an AVR. |
| 5 | Multi-step autonomous action | LLM-improvised tool chains, <= 6 rounds | No `Plan`, no `PlanStep`, no preconditions, no fallback, no resumable execution. |
| 6 | Perception | `VoicePipeline` (ASR/TTS) only | No `PerceptionEvent`, no camera/occupancy/ambient, no path from a sensor into state. |
| 7 | Cross-OS abstraction | **good** (HAL + 5 adapters) | The HAL is *TV-shaped* (`system`/`apps`/`navigation`) rather than *capability-shaped*; it cannot express "wake the PS5 over CEC". No Titan/Xumo/Roku stubs. |
| 8 | Tool execution | **good** | Tools lack `discover()` / `canExecute()` / `verify()` / `rollback()`. |
| 9 | Verification | none | `execute -> assume success`. `set_input_source` returns `undefined` and nothing reads the input back. |
| 10 | Policy / permission | binary `confirm: true` on three tools | No risk taxonomy, no policy engine, no parental/privacy/enterprise hooks, no audit trail. |

### Coupling and technical debt found

1. **`tv-tools.ts` hard-codes the tool catalogue against the HAL shape.** Fifteen
   tools written by hand; adding a capability means editing core. It should be
   *generated from the Capability Graph*.
2. **`capability-probe.ts` maps groups to tool names by string matching** —
   `agent.ts:reasonFor` guesses the group from `name.includes("volume")`. That is
   a Capability Graph struggling to be born inside a naming convention.
3. **`ConversationContext` is doing double duty as memory.** Anything the agent
   should *know* (volume, current input) is only recoverable by re-reading chat
   history, which is trimmed at 12 messages.
4. **The confirm gate lives in the agent loop**, keyed off a boolean on the tool
   spec. Policy can see one call at a time, never the plan.
5. **`InputSource` is a closed union in `platform-api`.** Fine for a TV, wrong
   for a living room: `hdmi2` names a port, not the PS5 behind it.
6. **Hosts duplicate wiring.** `apps/dev-harness`, `apps/cli` and each device
   host assemble platform + llm + tools + ui by hand (~80 lines, drifting).
7. **`apps/aosp-app/**/build`, `.gradle` and `.idea` are committed** — build
   output and IDE state in git. Unrelated to this redesign, still worth a
   `.gitignore` pass.
8. **Untracked `tizen/` and `webos-app/` directories at the repo root** shadow
   `apps/tizen-app` / `apps/webos-app`. Decide which is real and delete the other.

---

## 3. Target architecture

```
                          +------------------------------+
   user intent ---------> |        AGENT CORE            |
   perception events ---> |  (no OS-specific code, ever) |
                          +------------------------------+
                          |  World Model    (what is)    | <---+
                          |  Device Graph   (what exists)|     |
                          |  Capability Graph (what I can)|    |
                          |  Planner        (what next)  |     | observations
                          |  Policy         (what is ok) |     |
                          |  Verification   (did it work)|     |
                          |  Memory         (what happened)    |
                          +---------------+--------------+     |
                                          | capability invocation
                          +---------------v--------------+     |
                          |        TOOL LAYER            |-----+
                          | discover - canExecute -      |
                          | execute - verify - rollback  |
                          | tv - cec - ir - audio - net  |
                          | content - iot - perception   |
                          +---------------+--------------+
                          +---------------v--------------+
                          |       ADAPTER LAYER          |
                          | aosp - titan - xumo - webos  |
                          | tizen - roku - linux - mock  |
                          +------------------------------+
```

The agent loop becomes:

```
Intent -> Perception -> World Model -> Capability Graph -> Plan -> Policy
       -> Execute -> Verify -> Update World Model -> (replan | done)
```

Concretely, inside `packages/core/src`:

```
core/src/
|- agent/          the loop (existing) - gains a planner-driven mode
|- world/          LivingRoomState, Fact<T>, WorldModel, reconciliation   [NEW]
|- capabilities/   Capability, CapabilityGraph, HAL-derived catalogue     [NEW]
|- devices/        DeviceNode, DeviceGraph, DiscoverySource               [NEW]
|- perception/     PerceptionEvent, applyPerception                       [NEW]
|- planner/        Goal, Plan, PlanStep, Planner, execute + verify        [NEW]
|- policy/         RiskLevel, PolicyEngine, PolicyDecision                [NEW]
|- skills/         declarative scenarios (gaming_session, movie_night...) [NEW]
|- tools/          registry, tv-tools, result envelope (existing)
|- memory/         conversation context (existing)
|- events/         bus (existing)
`- diagnostics/    probe (existing)
```

Non-negotiable dependency rule, enforceable by lint:

```
world, capabilities, devices, planner, policy, perception, memory
        -- may import -->  platform-api *types* only
        -- must NOT import -->  adapter-*, tizen.*, adb, luna, any OS symbol
```

`AgentCore` never learns the name of an OS. Adding Titan OS or Xumo must touch
`adapters/` and nothing else — that is the single test of whether this
architecture is holding.

---

## 4. Migration plan (no big bang)

| Stage | Change | Risk |
|---|---|---|
| **M0** — *done in this change* | Add `world/`, `capabilities/`, `devices/`, `perception/`, `planner/`, `policy/`, `skills/` as **additive** modules with their own tests. Nothing in the existing loop changes; the 484 existing tests stay green. | none |
| **M1** — *done* | Tools are generated from the capability catalogue; `tv-tools.ts` now holds only the platform calls, and `confirm` is derived from `riskLevel`. Behaviour-equivalent, proved by `packages/acceptance`. (The string matching in `reasonFor` moves in M3.) | low |
| **M2** | Feed every `tool:result` into the World Model. Inject a compact world snapshot into the system prompt. | low — additive prompt context |
| **M3** | Add the verification loop: each capability declares how it is verified; the executor runs it and reports `verified` / `unverified` / `failed`. | medium — needs a read-back per capability |
| **M4** | Introduce `Planner` alongside LLM tool-calling. Goal-based path for the four P0 scenarios; free-form chat keeps the existing path. | medium — two paths coexist by design |
| **M5** | Route every execution through `PolicyEngine`; the existing `confirm` handler becomes one policy outcome (`ask_user`). | low |
| **M6** | Device discovery (CEC first) populates the Device Graph; `set_input_source(hdmi2)` becomes `activate(device: ps5)`. | medium — hardware-gated |
| **M7** | Adapter stubs for Titan OS / Xumo / Roku: interface plus contract test only. | low, and deliberately last |

Each stage is independently shippable and independently revertible.

---

## 5. P0 implementation

Platform: **Android TV emulator + mock adapter only.** No hardware, no CEC, no
camera. Four scenarios, and the point of each is that it is *not* a command
mapping:

| Scenario | Utterance | What must be visible |
|---|---|---|
| A | 「切到 HDMI2」 | one capability, but chosen from the graph and **verified** by a read-back |
| B | 「我要打 PS5」 | goal `gaming_session_active` — a multi-step plan over TV + device graph, with preconditions |
| C | 「我要看電影」 | goal `movie_night` — the content provider is *a tool*, never the core |
| D | 「小聲一點」 | a relative intent resolved against **world state**, not a re-read guess |

Acceptance for P0 lives in `packages/acceptance` and runs headless in CI.

See [roadmap.md](roadmap.md) for P0-P3 and the next ten implementation tasks.
