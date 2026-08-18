# Capability Graph

> The core IP. The agent must not know "this is Android TV". It must know
> "on this device I can `tv.input.switch`, and here is what that costs, requires,
> risks and how I check it worked".

Implementation: [`packages/core/src/capabilities/`](../packages/core/src/capabilities/).

## Why this is P0/P1 and not a nice-to-have

Everything above it is downstream. The planner cannot plan over capabilities it
cannot enumerate; policy cannot gate what it cannot classify by risk;
verification cannot check what did not declare how it is checked. And it is the
piece that makes "add Titan OS by adding an adapter" true rather than
aspirational — an adapter's job becomes *contributing capabilities*.

Where it came from: a flat `ToolSpec[]` plus `capability-probe.ts`, which
withdrew tools whose group read reported `unsupported` and mapped groups back to
tools by string matching on the tool name. It worked, and it was a Capability
Graph trying to be born inside a naming convention. The tools are now projected
from the graph (M1); the probe still matches by name and is next (M3).

## The descriptor

```ts
interface Capability {
  id: string;                    // "tv.audio.set_volume" — stable, namespaced
  name: string;                  // human/LLM-facing
  description: string;
  device: string;                // device-graph node id; "tv" for the host TV
  domain: CapabilityDomain;      // power | display | audio | input | app | content | device | iot | perception | network
  parameters: Record<string, ToolParameter>;   // reuses the existing tool schema
  constraints?: Constraint[];    // "level between 0 and 100"
  preconditions?: StatePredicate[];   // "tv.power == on"
  sideEffects?: StateEffect[];        // "tv.volume := level"
  riskLevel: RiskLevel;          // low | medium | high | critical
  verification?: Verification;   // how to prove it worked
  provider: string;              // "adapter:aosp" | "cec" | "ir" | "skill:xumo"
  confidence: number;            // 0..1 — how sure we are this device really has it
  status: "available" | "unverified" | "withdrawn";
}
```

`preconditions` and `sideEffects` are expressed against **World Model paths**,
which is what lets the planner chain steps without any hard-coded knowledge:

```ts
{
  id: "tv.input.switch",
  preconditions: [{ path: "tv.power", equals: "on" }],
  sideEffects:  [{ path: "tv.input", set: "{source}" }],
  verification: { kind: "read_back", capability: "tv.input.get_source", predicate: { path: "tv.input", equals: "{source}" } },
  riskLevel: "medium",   // it takes the screen away from whoever is watching
}
```

## The tree

```
TV
|- Power
|   |- power_on
|   `- power_off / standby
|- Display
|   |- set_picture_mode
|   |- enable_game_mode
|   |- enable_hdr
|   `- set_backlight
|- Audio
|   |- set_volume / get_volume
|   |- mute / get_mute
|   |- set_audio_mode
|   `- enable_drc
|- Input
|   |- list_inputs
|   |- get_current_input
|   `- switch_input
|- App
|   |- list_apps / search_app / launch_app
|   `- foreground_app
`- Device Control (transports, not capabilities themselves)
    |- HDMI-CEC
    |- IR
    |- Bluetooth
    `- Network API
```

The tree is a *view*; the store is flat and keyed by id, because a capability can
belong to more than one device and be provided by more than one transport.

## Multiple providers for one capability

This is the reason the graph earns its keep. `ps5.power.on` may be reachable via
HDMI-CEC, via a network wake packet, or via an IR blaster. Each is a separate
`Capability` entry with the same `id` and a different `provider`, ranked by
`confidence`. The planner asks for the id; the executor tries providers in rank
order and demotes one that fails verification.

## Discovery and lifecycle

```
adapter reports HAL surface  --\
boot capability probe        ---+--> CapabilityGraph.register(...)
device discovery (CEC/mDNS)  --/
                                      |
                     first call answers "unsupported"
                                      v
                             status: "withdrawn", confidence: 0
```

Three states, and the middle one matters: `unverified` means "the device claims
it, nothing has proved it". A capability with no side-effect-free read can only
ever be `unverified` until it is used — `tv.input.switch` on Tizen is exactly
that case, where the *read* works and the *write* is signing-gated forever.

Rules carried over from `capability-probe.ts`, unchanged because they are right:

- **Probe with reads only.** Never mutate the TV to find out what it can do.
- **Withdraw on `unsupported` only.** `failed` and `offline` are bad moments,
  not missing capabilities.
- **A read vouches only for what it declares.** `vouchesFor` on the read
  capability names the ids it speaks for — usually its own group, because read
  and write share one platform object, and sometimes only itself:
  `tv.input.get_source` reads fine on Tizen while `tv.input.switch` is
  signing-gated forever.

## Relationship to tools

```
Capability (what can be done, with what risk, verified how)
      |  projected into
      v
ToolSpec  (what the LLM is allowed to ask for, this turn)
```

Tools become a *projection* of the graph, filtered by status, by policy and by
the current activity. The LLM never sees a withdrawn capability, and never sees a
capability whose preconditions are unsatisfiable in the current world state.

**Done (M1).** `createTvCapabilities()` is the source of truth; `createTvTools()`
supplies only the platform calls, and `toolsFromCapabilities()` projects the
rest. `confirm` is derived from `riskLevel`, so the two can no longer drift.
`packages/acceptance` proves the model-facing vocabulary did not change.

## What the graph gives the planner

```ts
graph.list({ domain: "audio", device: "tv" })
graph.get("tv.input.switch")
graph.achieving({ path: "tv.input", value: "hdmi2" })  // which capabilities set this?
graph.usable()                                          // not withdrawn
toolsFromCapabilities(graph.usable(), handlers)         // the projection the LLM sees
```

`achieving()` is the planner's entry point: goal-based planning is a search from
*desired state* backwards through `sideEffects` to a capability that produces it.
