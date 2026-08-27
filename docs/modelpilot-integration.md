# ModelPilot integration

**What crosses to ModelPilot:** a goal and a minimised room summary.
**What comes back:** a *plan*.
**What never leaves the television:** device control, and the decision that
something actually happened.

Implementation: [`packages/modelpilot`](../packages/modelpilot).
Decision record: [ADR-0004](adr/0004-modelpilot-boundary.md).

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
      │  then the built-in LLM        ModelPilot  (Cloudflare)
      │  planner)                          │  action plan JSON
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
2. **A ModelPilot task reported `verified` is not a claim about the television.**
   It means the engine stands behind its *answer*. Whether the TV switched is
   decided afterwards, locally, by reading it back — and the two disagree often
   enough that the distinction is the point. On Android, `setInputSource` from a
   third-party app is accepted and does nothing.

## The three modes

| `MODELPILOT_MODE` | Calls ModelPilot? | What runs on the TV |
|---|---|---|
| `off` | no | the existing local path, unchanged |
| `shadow` *(default)* | yes | **the local plan** — device behaviour is identical to `off` |
| `enforce` | yes | ModelPilot's plan, after local validation and policy |

`shadow` keeps the suggestion, the task id, the trajectory id and a comparison
(`same` / `different` / `local_only` / `remote_only`) so the two paths can be
evaluated against each other on real hardware without any risk to the device.

**With no API key configured, the resolved mode is `off`** whatever was
requested. Configuring the key is the act that opts a device in; a television
quietly trying to reach a cloud endpoint it has no credential for is both noisy
and wrong.

### Fallback policy, stated

| Situation | Behaviour |
|---|---|
| Not configured, `off`, no client | local planner. Telemetry `status: skipped`. |
| Timeout, unreachable, 5xx, 401/403, malformed request | local planner, `status: error`, `fallback_reason` set. `onUnavailable: "refuse"` returns an empty plan instead. |
| Reached, task **unverified/failed** | **no fallback.** Empty plan, `blocked` set, task and trajectory ids recorded. Recovery or `ask_user`. |
| Reached, answer **fails the JSON schema** | **no fallback.** Same as above. |
| Reached, answer names a capability this device lacks | empty plan with a rejection naming it. |

The asymmetry is deliberate. Availability problems are ours to route around; an
answer we cannot act on is the engine's, and quietly substituting our own plan
would be replacing the accountable answer with an unaccountable one. **Policy is
never bypassed in any mode**, because policy runs in the executor, below every
planner.

`enforceScope: "unmeasurable"` narrows enforce to the goals the deterministic
planner cannot close — "a bit quieter" then costs no tokens, no latency and no
network. Default is `"all"`.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `MODELPILOT_API_KEY` | — | **Environment or host global only.** Never read from the launch URL; see below. No key ⇒ mode `off`. |
| `MODELPILOT_MODE` | `shadow` | `off` \| `shadow` \| `enforce` |
| `MODELPILOT_BASE_URL` | `https://modelpilot.andycywu.workers.dev` | point at `tools/mock-modelpilot-server.mjs` for testing |
| `MODELPILOT_TIMEOUT_MS` | `5000` | per call; also the abort deadline |
| `MODELPILOT_MAX_COST` | `0.05` | USD, sent as `economics.maxTaskBudget` |

On a device host, the same values as globals: `__MODELPILOT_API_KEY__`,
`__MODELPILOT_MODE__`, `__MODELPILOT_BASE_URL__`, `__MODELPILOT_TIMEOUT_MS__`,
`__MODELPILOT_MAX_COST__`. The mode (not the key) may also come from the launch
URL: `?modelpilot=enforce`, `?modelpilotUrl=…`, `?modelpilotTimeout=…`.

**Why the key is not a URL flag** — this repo has already shipped that bug once:
`?key=sk-…` was printed on a television's own status line, and on a shipped TV
that key is the same on every unit of the model. A launch URL also lives in shell
history, in the launch intent and in logcat.

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

`dataPolicy` on every request: `sensitivity: confidential`,
`retentionRequirement: zero`, `trainingUse: prohibited`, `toolEgress: denied`,
`humanReview: allowed`.

## Telemetry

One record per call, built from named fields and passed through
`sanitizeTelemetry` before it reaches a sink: `local_workflow_id`,
`modelpilot_task_id`, `trajectory_id`, `mode`, `task_type`, `status`,
`latency_ms`, `actual_cost`, `verification_result`, `local_action_result`,
`local_final_verification`, `fallback_reason`, `missing_fields`,
`shadow_agreement`. Never the key, a prompt, a frame, audio, or room state — a
field whose *name* looks like any of those is dropped, and the drop is recorded.

`missing_fields` exists because the response schema is read tolerantly: a
response with no trajectory id says so once, rather than logging `undefined`.

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

Then the four answers that must leave the television alone — restart the server
with each and re-run step 3:

| `--answer` | Expected |
|---|---|
| `unverified` | `achieved: false`, summary names the task, TV unchanged |
| `invalid` | `achieved: false`, summary lists the missing keys, TV unchanged |
| `power` | rejection: no capability performs it, TV unchanged |
| `slow` | timeout, fallback to the local plan, `fallback_reason` set |

The server prints what crossed the boundary (with the authorization header
removed), which is the other half of the check: read the `context=` line and
confirm there is nothing in it you would not want in a log.

On a real device, the same thing through the dev harness or a device host:
set `window.__MODELPILOT_API_KEY__` before the bundle loads and launch with
`?modelpilot=shadow`.

## Unresolved risks

1. **The response schema is assumed.** Ids, status and cost are read from several
   plausible field names; `decideExecution` is mapped onto the documented execute
   endpoint with `strategy: "decide"` because no decision path is documented.
   Both are marked in `client.ts` and both are one-line corrections
   (`paths.decide`, `readTaskResult`). **Nothing here has run against the
   production service** — only against the mock.
2. **REST, not MCP.** Deliberate ([ADR-0004](adr/0004-modelpilot-boundary.md)): an
   MCP client is a large dependency for a TV bundle. If a ModelPilot tool gains
   streaming or server-initiated messages, that decision needs revisiting.
3. **Cost is measured, but only against scripted intents.** `PlanningMeter`
   counts every plan by source, and `pnpm bench` reports it: **the four P0
   scenarios plan for 100% zero tokens** on the mock adapter — the deterministic
   planner closes all of them, in 1.7ms average, with no model call. That is the
   number `enforceScope: "unmeasurable"` protects.
   What is still unknown is the ratio on *real* utterances, which by definition
   include the ones no skill covers; those fall to a model. Nothing about the
   measurement is sent anywhere — local counters, read by `agent.planning`, the
   device report and the bench.
4. **`getTaskEvidence` and `getTaskTrajectory` are implemented and unused.** They
   are there for a host that wants to store or display evidence; nothing calls
   them yet, so their response shapes are the least validated part of the client.
5. **Latency on TV silicon.** A 5s budget is generous on a laptop and untested on
   MTK/NVT, where the WebView, the bridge and a weak radio all add to it.
6. **Shadow comparison is shallow.** It compares capability ids and arguments as
   strings. Two plans that differ only in ordering read as `different`.
7. **No approval flow for `high_risk` beyond the local one.** `approvalMode:
   "high_risk"` is sent, and the local policy engine still decides. If ModelPilot
   grows its own human-approval loop, the two need reconciling rather than both
   asking.
