# Policy and Safety

> An agent that can control a living room needs a safety model before it can
> control a living room — not after. The cost of adding it now is a small module;
> the cost of adding it later is every call site.

Implementation: [`packages/core/src/policy/`](../packages/core/src/policy/).

## Where it sits

```
Plan --> Policy check --> Permission check --> Execute --> Audit
```

Policy runs **twice**: once over the whole plan (so the user is asked once, about
what is actually going to happen), and once per step immediately before
execution (because the world may have changed since the plan was made).

## Risk levels

| Level | Meaning | Default | Examples |
|---|---|---|---|
| `low` | Reversible, and it does not take the screen away from anyone | allow | volume, mute, picture mode, navigation keys, playing something the user just asked for |
| `medium` | Privacy-relevant, disruptive, or not trivially reversible | ask | switching input, launching an app over active playback, camera access, microphone access, standby, IoT lights |
| `high` | Money, identity, or persistent account state | ask, always | purchase content, subscribe, account or profile changes, factory-adjacent settings |
| `critical` | Physical safety or security | deny by default; explicit, out-of-band grant only | door locks, garage, heating above a threshold, disabling a camera used for security |

Every `Capability` carries a `riskLevel`, so the level is a property of the
*capability*, not of a call site that might forget to check.

## The engine

```ts
interface PolicyEngine {
  check(request: PolicyRequest): PolicyDecision;
}

interface PolicyRequest {
  capability: Capability;
  args: Record<string, unknown>;
  world: WorldSnapshot;     // context: who is present, what time, what is playing
  actor: Actor;             // "user" | "agent" | "automation" | "remote"
  plan?: Plan;              // present for whole-plan checks
}

type PolicyDecision =
  | { effect: "allow" }
  | { effect: "ask"; prompt: string; risk: RiskLevel }
  | { effect: "deny"; reason: string; rule: string };   // reason is spoken to the user
```

Rules are evaluated in order and the **most restrictive wins**; a `deny` is never
overridden by a later `allow`. A denial always carries the rule id that produced
it, because "the agent refused and nobody can say why" is its own failure.

## Rule sources

| Source | Owner | Example |
|---|---|---|
| Built-in defaults | this repo | `critical` denied unless explicitly granted |
| Device policy | OEM / integrator | "this model has no camera consent flow — deny perception" |
| Parental control | account holder | kids profile: no purchases, no `medium`+ after 21:00, content rating cap |
| Privacy | user | camera off, microphone wake-word only, no cloud inference for perception |
| Enterprise | fleet admin | hotel or signage mode: no account changes, no input switching |
| Session | ad hoc | "don't ask me again this evening" — time-boxed, never permanent for `high` |

## Permission, distinct from policy

Policy asks *should this be allowed*. Permission asks *has this been granted*:
an OS-level grant (Android `RECORD_AUDIO`, camera consent), a signing privilege
(Tizen partner certificate for input switching), or an account entitlement.

Permission failures are a `Capability` concern — they surface as `unsupported`
and withdraw the capability. Policy failures are a *decision* and must be
explained to the user in their own language rather than reported as a fault.

## Perception, specifically

Camera and microphone are `medium` at minimum, and:

- Nothing starts a perception source without an explicit, revocable grant.
- Raw frames and raw audio **never** leave the perception layer and never enter
  the World Model, logs or the LLM prompt. Only derived `PerceptionEvent`s do.
- Recording is off by default and is not something a plan can turn on.
- A visible indicator whenever a sensor is live is a host requirement, not a
  suggestion.
- `child_detected` may tighten policy (content rating, volume ceiling) but must
  never be used for advertising or profiling in this runtime.

## Audit

Every decision emits an event: capability, args (redacted by declared sensitivity),
decision, rule id, actor, timestamp, plan id. Hosts can persist it. This is what
makes "why did the TV do that?" answerable, and it is the same event stream the
`?diag` view already knows how to render.

## Relationship to the old confirm gate

**Done (M5).** Both paths — chat tool calls and plan steps — go through
`PolicyEngine`. `ToolSpec.confirm` survives as the model-facing flag, and the
*decision* comes from the capability's `riskLevel`:

```
policy.check(...) -> { effect: "ask" } -> the host's existing confirm handler
```

The 10-foot dialog, the CLI prompt and the "declined" tool result all keep
working. A tool outside the catalogue — a custom tool, a manifest skill — gets a
stand-in capability (`capabilityForTool`) rather than a free pass, because a
policy layer with a hole in it is not one.

One behaviour changed. With no confirm handler, a tool marked `confirm: true`
used to run anyway; now it is **declined**, because an agent with nobody to ask
should not take the screen away from whoever is watching. A host that genuinely
has no user — a bring-up script, a kiosk — says so with `unattended: true`.
Every host in this repo already supplies a handler, so nothing shipped changes.

## Non-goals

- Not a general RBAC system.
- Not content moderation (that is the provider's job).
- Not DRM or entitlement enforcement.
