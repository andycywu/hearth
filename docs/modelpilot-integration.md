# ModelPilot integration

**What crosses to ModelPilot:** a goal and a minimised room summary.
**What comes back:** a *plan*.
**What never leaves the television:** device control, and the decision that
something actually happened.

Implementation: [`packages/modelpilot`](../packages/modelpilot).
Decision record: [ADR-0004](adr/0004-modelpilot-boundary.md).

## What ModelPilot is

A **cost-aware model routing control plane**, whose primary metric is Cost Per
Successful Task. It exposes an OpenAI-compatible endpoint, and `model: "auto"`
is what makes it route: it profiles the request, filters the catalogue by
quality, cost, context and tool support, picks the best policy-adjusted score,
and falls through to stronger candidates when one fails. Its whole public API is
three endpoints:

| | |
|---|---|
| `GET /v1/models` | the catalogue |
| `POST /v1/chat/completions` | OpenAI-compatible; `model: "auto"` routes |
| `POST /v1/feedback` | `{ request_id, success, score? }` — the CST verifier |

**The first version of this integration was written against a different service.**
It assumed a decision engine: `POST /v1/tasks/execute`, `GET /v1/tasks/:id`,
`GET /v1/trajectories/:id`, task ids, trajectory ids, a `dataPolicy` block, and a
per-task verification verdict. None of that exists. Pointed at production it
would have 404'd on every call, fallen back to the local planner, and looked from
the outside like a service that was simply always down — while 46 tests stayed
green, because the mock server was written from the same misreading. That is
recorded here rather than quietly fixed: a mock is a claim about somebody else's
server, and when it is wrong it does not fail, it agrees with you.

---

## Where it plugs in

The agent already had two planners and a seam between them. ModelPilot becomes a
third planner behind the same seam — it does not become a new execution path, and
nothing about the tool layer, the HAL or the adapters changed.

```
utterance / goal
      │
      ▼
Agent.pursue / pursueSkill / pursueIntent          (unchanged)
      │
      ▼
AgentOptions.planner ──────────────► ModelPilotPlanner
      │                                   │  minimised summary + goal
      │ (default: GoalPlanner,             ▼
      │  then the built-in LLM        ModelPilot  (Cloudflare Worker)
      │  planner)                          │  routes to a model; returns
      │                                    │  a completion + request_id
      │                                    ▼
      │                             parseActionPlan  ── invalid ─► no device operation
      │                                    │                        recover / ask_user
      ▼                                    ▼
   Plan ◄──────────────── buildStep(capability graph)
      │                   preconditions, expected effects,
      │                   verification and fallbacks come
      │                   from THIS device, never from the answer
      ▼
PolicyEngine            risk levels, parental/enterprise rules, confirmation
      │
      ▼
PlanExecutor ──► ToolRegistry ──► PlatformProvider (HAL) ──► TV / CEC / IR
      │
      ▼
local verification: read the device back
      │
      ├─ verified    the read-back agreed
      ├─ unverified  nothing on this device can confirm it
      ├─ unsupported this device cannot do it at all
      └─ failed      accepted, and the device did not change
      │
      ▼
WorldModel  ◄── only what was actually observed
```

Two properties this ordering buys:

1. **A remote engine cannot weaken a local check.** It proposes a capability id
   and arguments; `buildStep` supplies the preconditions, the expected effects,
   the verification method and the fallback providers from the local Capability
   Graph. An answer naming a capability this TV does not have is a rejection, not
   a step.
2. **Nothing ModelPilot returns is a claim about the television.** It returns a
   completion. Whether the TV switched is decided afterwards, locally, by reading
   it back. On Android, `setInputSource` from a third-party app is accepted and
   does nothing.

### `evaluation_status` is not a gate, and gating on it broke enforce mode

Every completion comes back with `modelpilot.evaluation_status: "unverified"`.
That is not a verdict on the answer — it is CST bookkeeping. ModelPilot
deliberately does not count a task successful until a verifier confirms the
outcome through `/v1/feedback`, so a *fresh* completion is unverified by
construction and stays that way until somebody says otherwise.

The planner used to read it as "the engine does not stand behind this answer" and
refuse to act. Combined with the above, that meant **enforce mode blocked on
every single call it ever made** — and the mock, written from the same reading,
returned `status: "verified"` so the tests never saw it.

Three different things are now three different things:

| | decided by | means |
|---|---|---|
| is the answer *usable* | `parseActionPlan`, locally | the JSON is a plan this device can name |
| did the *television* do it | the local read-back | `verified` / `unverified` / `unsupported` / `failed` |
| does *ModelPilot* count it successful | `POST /v1/feedback` | the CST denominator |

The third is downstream of the second — see
[Closing the loop](#closing-the-loop-the-television-is-modelpilots-verifier).

## The three modes

| `MODELPILOT_MODE` | Calls ModelPilot? | What runs on the TV |
|---|---|---|
| `off` | no | the existing local path, unchanged |
| `shadow` *(default)* | yes | **the local plan** — device behaviour is identical to `off` |
| `enforce` | yes | ModelPilot's plan, after local validation and policy |

`shadow` keeps the suggestion, the request id, the model that answered and a
comparison (`same` / `different` / `local_only` / `remote_only`) so the two paths
can be evaluated against each other on real hardware without any risk to the
device.

**With no API key configured, the resolved mode is `off`** whatever was
requested. Configuring the key is the act that opts a device in; a television
quietly trying to reach a cloud endpoint it has no credential for is both noisy
and wrong.

### Fallback policy, stated

| Situation | Behaviour |
|---|---|
| Not configured, `off`, no client | local planner. Telemetry `status: skipped`. |
| Timeout, unreachable, 5xx, 401/403, malformed request | local planner, `status: error`, `fallback_reason` set. `onUnavailable: "refuse"` returns an empty plan instead. |
| **429 — the tenant's month is spent** | same: local planner, `status: error`, `fallback_reason: rate_limited`. Its own error kind, because "the service is down" and "you are out of quota" want different reactions. |
| **422 — no eligible model** | same, and the service's own message is carried through. Usually means the tenant configured no provider credential, or the quality threshold excluded the catalogue. |
| Reached, answer **fails the JSON schema** | **no fallback.** Empty plan, request id and model recorded. Recovery or `ask_user`. |
| Reached, answer names a capability this device lacks | empty plan with a rejection naming it. |
| Reached, answer is a plausible 200 that is not a plan | fails the schema, so: no fallback, no device operation. |

The asymmetry is deliberate. Availability problems are ours to route around; an
answer we cannot act on is the engine's, and quietly substituting our own plan
would be replacing the accountable answer with an unaccountable one. **Policy is
never bypassed in any mode**, because policy runs in the executor, below every
planner.

`enforceScope: "unmeasurable"` narrows enforce to the goals the deterministic
planner cannot close — "a bit quieter" then costs no tokens, no latency and no
network. Default is `"all"`.

## Measured against the live service

Run 2026-09-01 against the production Worker, with one OpenAI provider
credential configured on the tenant. The television is the mock web adapter, so
what this establishes is the ModelPilot half: the call goes out, a real model
answers, the strict parser accepts it, and the local verdict reaches
`/v1/feedback`. It establishes nothing about hardware.

| | |
|---|---|
| Plans sampled | 12, across four goals including one in Chinese |
| Parsed | **12 / 12** |
| Latency | min 2449ms · **p50 2864ms** · p90 3161ms · max 3272ms |
| Cost | **~$0.00017 per plan** · baseline (priciest eligible candidate) ~$0.0015 |
| Routed to | `openai-mini`, every time |
| Shadow agreement | `same` — the model independently chose the plan the deterministic planner had already built |
| Enforce | plan ran, read-back `verified`, `/v1/feedback` accepted |

[`scripts/latency-sample.mjs`](../packages/modelpilot/scripts/latency-sample.mjs)
produced the table; [`scripts/live-check.mjs`](../packages/modelpilot/scripts/live-check.mjs)
runs one shadow or enforce pass end to end. Both read the key from the
environment and print neither it nor the room state.

```bash
# .env.local holds MODELPILOT_API_KEY — .env* is gitignored
node --env-file=.env.local packages/modelpilot/scripts/live-check.mjs
node --env-file=.env.local packages/modelpilot/scripts/latency-sample.mjs 3
```

### Three things the first live call found, none of which a mock could

1. **`risk` came back as a sentence.** The model answered `"risk": "Switching to
   HDMI2 may not turn the PS5 on if it is powered off; the switch could fail if
   HDMI2 is unavailable or the TV is restricted/locked."` — sensible, useful, and
   not one of `low|medium|high`. The parser rejected the whole plan, correctly,
   and **the prompt was the bug**: it pinned the vocabulary for `action` and
   `target` and left `risk` open. The mock had always answered `"low"`, so
   nothing had ever disagreed with us.

2. **The routing was being decided by a word we did not mean.** The response's
   own `routing_reason` read *"highest policy-adjusted score for
   **summarization**"*. The service profiles a task by scanning the message text
   against a keyword list in a fixed order, and this prompt said "room summary"
   twice — `summarization` matches on "summary" earlier in that list than
   `structured_extraction` matches on "json". Renaming it to "room state" fixed
   the route. Nothing failed while it was wrong; it quietly optimised for the
   wrong thing, which is the kind of defect that survives a long time.

3. **20.3 seconds per plan.** `gpt-5-mini` is a reasoning model, and it spent
   **704 of 748 completion tokens reasoning** about a four-field answer. Adding
   `reasoning_effort: "minimal"` — forwarded verbatim by the OpenAI-compatible
   path, dropped by the Anthropic and Gemini paths, so it is safe to send —
   brought the same request to 4.4s with zero reasoning tokens, **a tenth of the
   cost**, and a marginally better answer. A plan step is a decision, not an
   essay: the reasoning that matters is the Capability Graph's, and the model is
   picking one action out of seven with the options in front of it.

The default timeout moved from 5000ms to **8000ms** on the back of this. 5000
was a round number; 8000 is about 2.5× the measured p90, chosen because the
*first* call of a process repeatedly ran long — a cold Worker plus a cold
provider connection, which is exactly a household's first request of the evening.

### Candidate fallback, exercised

The router builds `[chosen, ...alternatives]` and walks it, moving to the next
candidate only when a failure is **retryable** — 429, 5xx or a network error — or
when the credential is "not configured". A 401 from a bad key does the opposite:
it breaks the loop. So an invalid credential cannot be used to test this, which
is worth knowing before someone tries.

What can: the service keeps a `mock` provider that throws a retryable error when
the last message contains `[fail:<model id>]`. Rank that model first — profile
the task as summarisation, which is one of its strengths, and drop
`quality_threshold` below its 0.8 — and then make it fail.

| Request | Result |
|---|---|
| `quality_threshold: 0.7`, summarisation-shaped | `selected_model: mock-fast`, `fallback_count: 0` |
| same, plus `[fail:mock-fast]` | `selected_model: openai-mini`, **`fallback_count: 2`** |
| `model: "mock-fast"` pinned, plus `[fail:mock-fast]` | **HTTP 502** `All eligible providers failed: Forced mock failure` |

Three things this settled:

1. **The 0.85 default threshold is doing exactly what it claims.** At 0.7 the
   catalogue's stand-in model wins the score outright and answers with an echo of
   the prompt. At 0.85 it is not eligible at all. That is no longer an argument,
   it is a measurement.
2. **A total routing failure is a 5xx**, so this runtime classifies it `server`,
   falls back to the local plan and records why — which is the correct handling
   and now a tested path rather than an assumed one.
3. **A client cannot see *which* candidates failed, only how many.**
   `fallback_count: 2` means two candidates failed before one answered, and the
   response says nothing about who they were. For this runtime's telemetry the
   count is enough; for debugging a household it would not be, and the chain
   lives server-side in the tenant's own routing activity.

### And one thing to watch

On the ambiguous goal — *"put the news on"*, with no news app in the capability
list — the model answered `ask_user` on three sampled runs and
`set_input(hdmi2)` on a fourth. Both are valid plans and only one is a good one.
Nothing here is broken: `ask_user` is the right answer, the fourth was locally
valid so it ran, and on a real television `tv.input.switch` is medium-risk and
meets the confirmation gate before anything happens. It is recorded because it is
the argument for `shadow`: run it long enough to see the distribution before
letting it steer.

## Closing the loop: the television is ModelPilot's verifier

ModelPilot's primary metric is Cost Per Successful Task, and it deliberately does
not count a completed API call as a successful task until something confirms the
outcome. On a television, **this runtime is that something**, and a better one
than user feedback: it read the device back.

One line at the host wires it:

```ts
agent.events.on("plan:end", ({ outcome }) => planner.report(outcome));
```

`report` is safe to hand every plan the agent finishes — one from another
planner, or from any mode but enforce, is not in the ledger and is ignored. It
never rejects: a verdict that does not arrive changes nothing on the television,
so it is worth one telemetry line and no retry.

### What is reported, and what is deliberately not

| Outcome | Posted | Why |
|---|---|---|
| every step `verified` / `satisfied` | `success: true` | the read-back agreed — the only unambiguous yes |
| any step `failed` | `success: false` | **the row this whole integration exists to produce**: an answer the router billed for that did not work on real hardware |
| the answer was unusable (no steps, a rejection) | `success: false` | a plan failing the schema, or naming a capability this device lacks, is the answer's fault — and the one thing CST would otherwise never hear |
| any step `unverified` | *nothing* | nothing here can confirm it; reporting either way launders a guess into somebody's primary metric |
| any step `unsupported` | *nothing* | a fact about this television, not about the answer |
| any step `denied` | *nothing* | local policy stopped it before it ran. Our rule, not their answer |
| `ask_user` / `no_op` | *nothing* | an engine asking for a human is the system working, and there is nothing to verify |
| **shadow mode, always** | *nothing* | the *local* plan ran. Reporting its outcome as ModelPilot's would be telling the service a TV did what its answer said, when its answer was never executed |

The asymmetry is the point, and it is the same one the four honest step statuses
are built on. A metric is only worth something if its denominator is honest, and
a runtime that reported its own uncertainty — in either direction — would be
quietly making CST worthless. How often this runtime has nothing to say is itself
recorded (`local_final_verification: "not_run"`), because that number matters too.

`score` is accepted by the endpoint and deliberately not sent: a made-up number
is noise in someone else's denominator.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `MODELPILOT_API_KEY` | — | **Environment, host global, or the Android keystore. Never the launch URL.** No key ⇒ mode `off`. |
| `MODELPILOT_MODE` | `shadow` | `off` \| `shadow` \| `enforce` |
| `MODELPILOT_BASE_URL` | `https://modelpilot.andycywu.workers.dev` | origin; `/v1/chat/completions` is appended. Point at `tools/mock-modelpilot-server.mjs` for testing |
| `MODELPILOT_TIMEOUT_MS` | `8000` | per call, and the abort deadline. The service takes a latency *weight*, not a deadline, so this is the only one. 8000 is measured, not chosen — see [Measured against the live service](#measured-against-the-live-service) |
| `MODELPILOT_MAX_COST` | `0.05` | USD, sent as `metadata.max_cost` |

On a device host, the same values as globals: `__MODELPILOT_API_KEY__`,
`__MODELPILOT_MODE__`, `__MODELPILOT_BASE_URL__`, `__MODELPILOT_TIMEOUT_MS__`,
`__MODELPILOT_MAX_COST__`. The mode (not the key) may also come from the launch
URL: `?modelpilot=enforce`, `?modelpilotUrl=…`, `?modelpilotTimeout=…`.

### Where the key actually goes

| Host | How |
|---|---|
| CLI / Node | `MODELPILOT_API_KEY` in the environment. Copy `.env.example` to `.env.local` — `.env*` is gitignored. |
| Dev harness | `window.__MODELPILOT_API_KEY__ = "…"` before the bundle loads |
| Android TV | `adb shell am start -n tv.aiagent.harness/.MainActivity -e mpKey <key>` — stored AES-GCM encrypted in the device keystore ([`LlmSecrets`](../apps/aosp-app/app/src/main/java/tv/aiagent/harness/LlmSecrets.kt)), removed from the intent, never logged, and read back through the bridge |
| Tizen / webOS | host global, set before the bundle loads |

**Why the key is not a URL flag** — this repo has already shipped that bug once:
`?key=sk-…` was printed on a television's own status line, and on a shipped TV
that key is the same on every unit of the model. A launch URL also lives in shell
history, in the launch intent and in logcat.

**And why nothing key-shaped reaches git**: `pnpm secrets:check` scans tracked
files (or `--staged`) for credential patterns and runs in CI. It is a tripwire,
not a guarantee — the real defence is that no host reads a key from anywhere a
repository can see.

## What is sent, and what is not

`minimiseRoomState` is an **allowlist**, so a new world path cannot leak by
default. Sent:

- eight TV/content facts: `tv.power`, `tv.input`, `tv.volume`, `tv.muted`,
  `tv.pictureMode`, `content.state`, `audio.profile`, `currentActivity`;
- occupancy coarsened to `occupied` / `empty`;
- device **ids, kinds and HDMI ports**;
- usable capability **ids**.

Not sent, and each has a test: raw frames or audio, transcripts, `room.childPresent`,
people counts, names, device vendors/models/IPs/MACs, serial numbers, account
details, conversation history, or any world path not on the list.

### The three fields the service actually reads

`metadata.quality_threshold`, `metadata.latency_priority` and
`metadata.max_cost`. Everything else about the routing decision — task type,
complexity, token estimate, whether tools are needed — ModelPilot infers from the
messages.

Two consequences worth knowing before a bring-up:

- **The wording of the system message picks the route.** ModelPilot profiles the
  task by scanning the joined message text in a fixed order, and
  `structured_extraction` matches on "json" before `reasoning` or `planning` can
  match on "plan". That is the profile we want, and it is a coupling to somebody
  else's regex list, so it is written down in `task-mapper.ts` rather than left to
  be rediscovered.
- **`quality_threshold` defaults to 0.85, and the number is load-bearing.**
  Price is part of a router's score, so the cheapest *eligible* candidate wins
  more often than not — and a model too weak to hold a schema does not fail
  loudly, it answers with prose. The threshold is what keeps the weak end of a
  catalogue out. It also buys the better failure: when nothing qualifies, the
  service answers `422 No eligible configured model satisfies this request
  policy`, which names a real configuration problem instead of costing a round
  trip to discover. The strict parser is the second line of defence; this is the
  first.

### What is no longer sent, and why that is honest

A `dataPolicy` block — `sensitivity: confidential`, `retentionRequirement: zero`,
`trainingUse: prohibited`, `toolEgress: denied` — used to ride on every request,
and this document used to present it as a guarantee. **Nothing read it.** It has
been removed rather than kept as decoration, and a test asserts it is absent,
because a retention promise in a field the server ignores is worse than no
promise: it reads like one.

The boundary that is real is `minimiseRoomState` — an allowlist that cannot pass
a new world path by default, with a test per category of thing that must not
cross. The server-side half (retention, training use, tool egress) has to be
implemented in ModelPilot before it can be claimed anywhere, and it is not.

## Counting installs

`x-hearth-install`, `x-hearth-runtime` and `x-hearth-mode` ride on requests that
were already going, so the service can answer "how many televisions, how often, on
which version" with no analytics endpoint and nothing that identifies hardware.
The id is random, device-generated and resettable. See
[service-metrics.md](service-metrics.md) — including the two things that have to
be settled before a fleet is switched on.

## Telemetry

Two records per ModelPilot call: one when the answer arrives, one when the
television has finished with it, joined by `local_workflow_id` and
`modelpilot_request_id`. They cannot be one record, because the call is over long
before the device is — the second carries `status: "outcome"`,
`local_action_result` (the step statuses, in order) and
`local_final_verification`.

Both are built from named fields and passed through `sanitizeTelemetry` before
they reach a sink: `local_workflow_id`,
`modelpilot_request_id`, `selected_model`, `fallback_count`, `mode`, `task_type`,
`status`, `latency_ms`, `actual_cost`, `baseline_cost`, `evaluation_status`,
`local_action_result`, `local_final_verification`, `fallback_reason`,
`missing_fields`, `shadow_agreement`. Never the key, a prompt, a frame, audio, or
room state — a field whose *name* looks like any of those is dropped, and the
drop is recorded.

Three of those are new and are the point of using a router at all:
`selected_model` (which model answered), `actual_cost` and `baseline_cost` (what
the priciest eligible candidate would have cost). Recorded side by side, they turn
"routing saves money" into a subtractable pair rather than a slogan.

`missing_fields` exists because the response is read tolerantly: a deployment
that returns no `request_id` says so once, rather than logging `undefined`.

## Switching shadow → enforce

1. Run in `shadow` on real hardware long enough to collect disagreements.
   `shadow_agreement: different` is the interesting bucket; read the plans.
2. Check the cost line: `actual_cost` per call against how many calls a household
   makes a day. Consider `enforceScope: "unmeasurable"`.
3. Decide the unavailability policy: `local` (default) or `refuse`.
4. Flip one value — `MODELPILOT_MODE=enforce`, or `?modelpilot=enforce` on a
   device for one launch. No rebuild.
5. Watch `local_final_verification`. The failure this integration is built to
   surface is a task ModelPilot verified that the television did not do.

Roll back the same way. Nothing about `enforce` is sticky.

## One manual test

```bash
# 1. a ModelPilot stand-in that proposes an input the local planner would not pick
node tools/mock-modelpilot-server.mjs --port 8090 --answer set_input:hdmi3 &

# 2. shadow: the engine is called, the device does what it always did
MODELPILOT_BASE_URL=http://127.0.0.1:8090 MODELPILOT_API_KEY=test-key \
MODELPILOT_MODE=shadow node packages/modelpilot/scripts/check.mjs

# 3. enforce: the engine's plan runs, and is verified locally
MODELPILOT_BASE_URL=http://127.0.0.1:8090 MODELPILOT_API_KEY=test-key \
MODELPILOT_MODE=enforce node packages/modelpilot/scripts/check.mjs
```

Then the answers that must leave the television alone — restart the server with
each and re-run step 3:

| `--answer` | Expected |
|---|---|
| `invalid` | `achieved: false`, summary lists the missing keys, TV unchanged |
| `not-a-plan` | a plausible 200 that is prose, not a plan: fails the schema, TV unchanged |
| `power` | rejection: no capability performs it, TV unchanged |
| `no-model` | 422 carried through, fallback to the local plan |
| `quota` | 429 as `rate_limited`, fallback to the local plan |
| `slow` | timeout, fallback to the local plan, `fallback_reason` set |

The server prints what crossed the boundary (with the authorization header
removed), which is the other half of the check: read the `user=` and `metadata=`
lines and confirm there is nothing in them you would not want in a log.

On a real device, the same thing through the dev harness or a device host:
set `window.__MODELPILOT_API_KEY__` before the bundle loads and launch with
`?modelpilot=shadow`.

## Unresolved risks

1. **One tenant, one provider, twelve plans, and a mock television.** The
   integration has now run against production — see [Measured against the live
   service](#measured-against-the-live-service) — which is the difference between
   "should work" and "worked twelve times". Still untested: the 429 wall, a
   second provider in the catalogue, fallback between candidates, and every one
   of these numbers on TV silicon rather than a laptop.
2. **Provisioning and quota are unsolved, and they are a shipping blocker.**
   ModelPilot is BYOK: a tenant configures the provider credentials the router
   draws on, so a device is only as capable as its tenant is configured. The Free
   plan allows 1000 requests a month **per tenant**, and `x-hearth-install` does
   not participate in that count. One key across a fleet means one heavy household can spend the
   month for every other television on that key. Either a key per device (a
   provisioning problem) or per-install accounting in the Worker (a service
   change) has to happen before this is switched on for more than one TV.
3. **REST, not MCP.** Still deliberate
   ([ADR-0004](adr/0004-modelpilot-boundary.md)), and now a weaker decision than
   it was: there is no MCP surface to weigh it against.
4. **Streaming is rejected outright by the service.** Planning does not need it,
   so this integration is unaffected — but the chat path's LLM connector does
   stream, so ModelPilot cannot be dropped in as the agent's conversational
   endpoint without a non-streaming switch.
5. **The feedback loop has run once, in one direction.** A live enforce pass
   posted a `success: true` verdict that the production service accepted — and
   since `/v1/feedback` answers 404 for a request it does not recognise, an
   accepted post is real evidence. What has not happened against production is
   the failure direction: a plan the television refuses or fails, because a mock
   TV does what it is told.
6. **Cost is measured, but only against scripted intents.** `PlanningMeter`
   counts every plan by source, and `pnpm bench` reports it: **the four P0
   scenarios plan for 100% zero tokens** on the mock adapter — the deterministic
   planner closes all of them, in 1.7ms average, with no model call. That is the
   number `enforceScope: "unmeasurable"` protects.
   What is still unknown is the ratio on *real* utterances, which by definition
   include the ones no skill covers; those fall to a model. Nothing about the
   measurement is sent anywhere — local counters, read by `agent.planning`, the
   device report and the bench.
7. **Latency on TV silicon.** A 5s budget is generous on a laptop and untested on
   MTK/NVT, where the WebView, the bridge and a weak radio all add to it.
8. **Shadow comparison is shallow.** It compares capability ids and arguments as
   strings. Two plans that differ only in ordering read as `different`.
9. **No approval flow beyond the local one.** The local policy engine decides,
   and there is nothing on the service side to reconcile it with — the
   `approvalMode: "high_risk"` that used to be sent was read by nobody. If
   ModelPilot grows a human-approval loop, the two need reconciling rather than
   both asking.
