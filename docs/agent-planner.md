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

## Driving it

```ts
const outcome = await agent.pursue({
  id: "input_switched",
  desiredState: [{ path: "tv.input", equals: "hdmi2" }],
});
agent.describe(outcome);   // "Done: tv.input.switch(source=hdmi2)."
```

or by scenario, which resolves its parameters against the room first:

```ts
const match = matchSkill("我要打 PS5");            // stopgap matcher, see below
if (match && isPlannable(match)) await agent.pursueSkill(match.skill, match.params);
```

Both paths live on the same agent and share one world, one tool registry, one
policy engine and one confirmation handler. Conversation is unchanged: anything
`matchSkill` does not recognise goes to `agent.run()` exactly as before. In the
dev harness, `?plan=off` forces the chat path — asking for HDMI2 both ways is the
clearest demonstration of the difference, because only one of them checks whether
it worked.

`matchSkill` is a **stopgap** and is labelled as one in the source: real intent
understanding is the LLM planner's job (roadmap task 9). It exists so the P0
scenarios can be driven with no model at all, which is what makes them
demonstrable offline and testable in CI.

`describe()` is mechanical English, which is a known limit — the agent otherwise
replies in the user's language. Phrasing an outcome through the model costs a
round trip the offline path cannot make; a host that wants a spoken reply in
another language should hand the outcome to the LLM itself.

## Planning strategies

Two, and they coexist:

1. **`SkillPlanner` (deterministic).** A skill declares a goal and an ordered
   recipe over capability *ids*. Fast, predictable, testable, offline. This is
   what runs the P0 scenarios and what the acceptance test pins.
2. **`createLlmPlanner`** *(done)*. The model receives the world summary, the
   available capabilities (with parameters and preconditions) and the goal, and
   returns steps as JSON. Handles the long tail — the goals nobody wrote a skill
   for.

Both emit the same `Plan`, so the executor, policy and verification are shared.
Free-form conversation keeps today's direct LLM tool-calling path; planning is
for goals, not chat.

### How much of a plan a model may author

The capability id and the arguments. Nothing else. Preconditions, expected
effects, verification and fallback providers all come from the graph via
`buildStep`, so a model cannot weaken a check it was never asked to write, cannot
claim an effect a capability does not declare, and cannot invent a way to mark its
own work as verified. What it can do is *choose badly*, and five checks run before
anything executes:

1. the capability does not exist, or this device withdrew it;
2. the arguments do not fit its schema — the same `validateArgs` the tool layer
   uses, so an enum violation is caught here and coercion behaves identically;
3. a required argument is missing;
4. a precondition is *false* and no earlier accepted step makes it true (unknown
   is not a rejection — it is a reason to look);
5. policy denies it outright.

Everything thrown out is recorded on `Plan.rejections` with its reason. A plan
that quietly lost half its steps looks like a plan that worked, and when the
proposer is a model this is the only place the reason survives. Prose, an
apology, fenced JSON, a bare array and an empty answer are all handled; anything
unparseable yields *no steps*, which is a plan that does nothing rather than one
that does something unintended.

### Which planner runs

The deterministic one always goes first. For a goal it can measure it is faster,
free, offline and identical every time, and asking a model to re-derive a computed
answer is paying for a chance to be wrong. The model is consulted only when the
graph could not close the gap — no measurable desired state, or predicates nothing
here can produce — and only when the host opted in with `llmPlanning: true`.

```ts
await agent.pursueIntent("shush for a second");
// -> a known skill if one matches; otherwise the model's plan, validated;
//    otherwise `undefined`, meaning "this is conversation, call run()"
```

`?plan=llm` in the dev harness turns it on.

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
- `unsupported` — this device cannot do it at all. Withdraw the capability and
  say so; never retry.

None of these may be collapsed into another. The `TvResult` envelope already draws
the `unsupported` / `failed` distinction for tool errors, and this reuses that
discipline one level up.

### Three honest answers to one plan

Switching an input is the same plan on every target, and
[`plan-acceptance.test.ts`](../packages/acceptance/src/plan-acceptance.test.ts)
pins what actually happens:

| Target | Outcome | Why |
|---|---|---|
| web, titan, xumo | `verified` | the write took and the read-back agrees |
| tizen, webos | `unsupported` | the adapter refuses up front — partner-signed API |
| aosp | `failed` | the write is **accepted and does nothing** |

The last row is the reason this design exists. On Android a third-party app cannot
switch the system TV input: the Intent is best-effort, it returns without
complaint, and the read afterwards still reports the old source. `execute -> assume
success` would have reported that as done — and then the World Model would have
been wrong, and every plan built on top of it too.

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
