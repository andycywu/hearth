# Agent Planner and Verification Loop

> From `Intent -> Command` to
> `Intent -> Desired State -> Current State -> Capability Graph -> Plan ->
> Policy -> Execute -> Verify -> Update World Model`.

Implementation: [`packages/core/src/planner/`](../packages/core/src/planner/).

## The difference, concretely

**「我要打 PS5」**

Command mapping (what we must *not* build):

```
intent: play_ps5  ->  switch_input("hdmi2")
```

Goal-based planning (what we build):

```
Goal:    gaming_session_active(device: ps5)

Current: tv.power = on
         tv.input = hdmi1
         content  = Netflix, playing
         devices.ps5.power = standby
         devices.ps5.connection = hdmi2
         tv.pictureMode = standard

Plan:
  1. content.stop            pre: content.state == playing        verify: content.state != playing
  2. ps5.power.on            pre: devices.ps5 exists              verify: devices.ps5.power == on   (fallback: cec -> wol -> ir)
  3. tv.input.switch(hdmi2)  pre: tv.power == on                  verify: tv.input == hdmi2
  4. tv.display.game_mode    pre: tv.input == hdmi2               verify: tv.pictureMode == game
  5. tv.audio.profile(game)  optional                             verify: audio.profile == game
```

Step 3's `hdmi2` is *derived* from the Device Graph, not written down. Step 2 has
three providers and picks one at execution time. Step 5 is optional, so its
failure does not fail the plan. Every step is verified. That is the difference,
and it is what the P0 acceptance test asserts.

## Data model

```ts
interface Goal {
  id: string;                       // "gaming_session_active"
  desiredState: StatePredicate[];   // world paths and required values
  constraints?: Constraint[];       // "do not exceed volume 40 after 22:00"
  optional?: StatePredicate[];      // nice to have; never fails the plan
}

interface Plan {
  id: string;
  goal: Goal;
  steps: PlanStep[];
  createdAt: number;
  rationale?: string;               // for the UI and for logs
}

interface PlanStep {
  id: string;
  action: Action;                   // { capabilityId, args }
  preconditions: StatePredicate[];
  expectedResult: StateEffect[];
  verification?: Verification;
  fallbacks?: Action[];             // tried in order when verification fails
  optional?: boolean;
  maxRetries?: number;              // default 1
}

type Verification =
  | { kind: "read_back"; capability: string; path: string; equals?: unknown; within?: number }
  | { kind: "state"; predicate: StatePredicate; timeoutMs?: number }
  | { kind: "perception"; event: string; timeoutMs?: number }
  | { kind: "none"; because: string };   // must be justified in writing
```

`{ kind: "none" }` requires a reason string. An unverifiable action should be a
deliberate, documented decision, not an omission.

## Planning strategies

Two, and they coexist:

1. **`SkillPlanner` (deterministic).** A skill declares a goal and an ordered
   recipe over capability *ids*. Fast, predictable, testable, offline. This is
   what runs the P0 scenarios and what the acceptance test pins.
2. **`LlmPlanner`.** The model receives the world summary, the available
   capabilities (with preconditions and effects) and the goal, and returns a
   `Plan` as JSON, which is then validated against the graph — a step naming an
   unknown capability, or one whose preconditions cannot be met, is rejected
   before anything executes. Handles the long tail.

Both emit the same `Plan`, so the executor, policy and verification are shared.
Free-form conversation keeps today's direct LLM tool-calling path; planning is
for goals, not chat.

## Execution

```
for each step:
    check preconditions against the world
        unmet and observable? -> insert an observation step and re-check
        unmet and not observable? -> fail (or skip, if optional)
    policy check (see policy-and-safety.md)
        deny -> abort with a reason the user hears
        ask  -> confirm with the user
    execute via the tool layer
    verify
        pass -> commit effects to the world at full confidence
        fail -> retry (<= maxRetries) -> next fallback provider -> replan -> tell the user
```

Three properties worth stating explicitly:

- **Never `execute -> assume success`.** An optimistic write enters the world at
  reduced confidence and is corrected by verification, or it does not enter.
- **A plan is resumable.** Steps are idempotent where the capability allows it,
  and an aborted plan records where it stopped, so "carry on" is possible.
- **Replanning is normal, not exceptional.** The world changed under us (someone
  picked up the remote) is the common case in a living room.

## Verification framework

Shared, because every layer needs the same answer to "did it actually work":

```ts
const outcome = await verify(step.verification, { world, capabilities, tools });
// -> { status: "verified" | "unverified" | "failed" | "skipped", observed?, expected?, detail? }
```

- `verified` — the read-back matched. Commit at confidence 1.0.
- `unverified` — no way to check on this device. Commit as `assumed`, ~0.6, and
  say so if the user asks.
- `failed` — the read-back contradicted the expectation. Do not commit; retry,
  fall back, or replan.

`unverified` and `failed` are different answers and must never be collapsed. The
existing `TvResult` envelope already draws the analogous distinction for tool
errors (`unsupported` vs `failed`), and this reuses that discipline one level up.

## Skills as declarative scenarios

Implementation: [`packages/core/src/skills/`](../packages/core/src/skills/).

A skill is a named goal with a recipe — **data, not platform code**:

```ts
{
  id: "gaming_session",
  description: "Get the room ready to play a console",
  goal: {
    id: "gaming_session_active",
    desiredState: [
      { path: "devices.{device}.power", equals: "on" },
      { path: "tv.input", equals: "{devicePort}" },
      { path: "tv.pictureMode", equals: "game" },
    ],
    optional: [{ path: "audio.profile", equals: "game" }],
  },
  recipe: ["content.stop", "device.power_on", "tv.input.switch", "tv.display.game_mode", "tv.audio.profile"],
}
```

Planned set: `gaming_session`, `movie_night`, `night_mode`, `kids_mode`,
`sports_mode`, `meeting_mode`, `music_mode`, `leave_home`. A skill that names a
capability the device does not have degrades — that step is dropped if optional,
or the skill reports what is missing. **No skill contains platform-specific
code.** If one ever needs to, the Capability Graph is missing an entry.
