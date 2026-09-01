# ADR-0004 — ModelPilot decides; the television verifies

_Status: accepted, 2026-08-27. Amended 2026-08-31 — see
[Amendment](#amendment-2026-08-31--the-service-is-a-router-not-a-decision-engine),
which corrects the premise of the Context below without changing any decision._

## Context

ModelPilot is an execution decision engine reachable over REST and Remote MCP. We
want the steps that need model intelligence — planning, reasoning, content
understanding — to go through it, while the physical operations stay where they
already work: the local HAL, the adapters, CEC and IR.

> **This paragraph was wrong, and it is left standing on purpose.** ModelPilot is
> a cost-aware *model router* with an OpenAI-compatible endpoint and no MCP
> surface. Every decision below survived the correction; the premise did not. See
> the amendment.

The repository already had the seams for this, which is most of why the
integration is small:

- `Planner` — `plan(goal): Promise<Plan>`, already implemented twice
  (deterministic, LLM).
- `buildStep` — builds a plan step's preconditions, effects, verification and
  fallbacks **from the local Capability Graph**, not from whoever proposed it.
- `PlanExecutor` — policy gate, execution, read-back verification, four honest
  outcomes.
- `WorldModel` — records only what was observed, with source and confidence.

## Decisions

### 1. ModelPilot is a planner, not an execution path

It returns a plan. The local executor decides whether each step may run, runs it,
and reads the device back. Nothing about the tool layer, the HAL or any adapter
changed, and no device control moved to Cloudflare.

The consequence worth stating: **a ModelPilot task reported `verified` is not a
claim about the television.** It means the engine stands behind its answer. On
Android, `setInputSource` from a third-party app is accepted and does nothing —
so "the engine verified it" and "the TV did it" are different facts, and only the
second one may mark a TV task successful.

### 2. REST, not Remote MCP — for now

The runtime ships inside a TV WebView, targets ES2020, has zero dependencies and
lives under a bundle-size budget. A Remote MCP client means JSON-RPC over SSE or
streamable HTTP plus a session lifecycle: a lot of bytes and a lot of failure
modes for four request/response calls that map cleanly onto `fetch`.

Revisit if a ModelPilot tool gains streaming or server-initiated messages. The
`ModelPilotClient` interface is the seam; a transport swap changes one file.

### 3. Shadow is the default, and no key means off

Three modes — `off`, `shadow`, `enforce` — with `shadow` default. Shadow calls the
engine, records the suggestion and the request id, compares it with the local
plan, and **runs the local plan**: device behaviour identical to `off`.

A missing API key forces `off` regardless of the requested mode. The default mode
*calls a cloud service*, and a television doing that with no credential
configured would be both noisy and wrong. Configuring the key is the opt-in.

### 4. Availability failures may fall back; unusable answers may not

An unreachable engine, a timeout, a 5xx or a rejected credential is our problem
to route around: enforce falls back to the local planner and records why
(`onUnavailable: "refuse"` for a host that would rather stop).

An engine that **answers** with something unusable — a plan missing required keys,
one naming a capability this device lacks, or (a case only the real service made
visible) a perfectly ordinary 200 whose content is prose rather than a plan —
gets no fallback.
Substituting our own plan would replace the accountable answer with an
unaccountable one. Those return an empty plan carrying the request id and the
model that produced it, which sends the agent to recovery or to the user.

Policy is never bypassed in any mode, because policy runs in the executor, below
every planner.

### 5. Minimisation is an allowlist, not a filter

`minimiseRoomState` names the eight world paths that may be summarised, coarsens
occupancy to `occupied`/`empty`, and sends device ids, kinds and ports but never
names, vendors, models, IPs or MACs. A new world path — a serial number, an
account email, a transcript that somehow reached the world — does not leak,
because it was never named.

`room.childPresent` is deliberately excluded even though it would change a plan.
It is exactly the kind of inference a family would not expect to leave their
television.

### 6. The API key is never a URL flag

Environment or host global only. This repo shipped the other version once:
`?key=sk-…` printed on a television's status line, where the key is identical on
every unit of the model, and where the URL also lives in shell history, the launch
intent and logcat.

## What this cost, and what it found

The integration is ~1,100 lines including tests, and it changed three lines of the
agent: one option, and a `buildPlan` that delegates to an injected planner.

Two defects surfaced while building it, both in code that predates ModelPilot:

- **A refused plan reported success.** `PlanOutcome.achieved` was computed from
  the goal's unmet predicates, so a free-form goal with nothing measurable read
  `achieved: true` — with "nothing to do, it was already how you wanted it" —
  after the engine's answer had been rejected and the TV deliberately left alone.
  A plan whose every step was thrown out now reports `achieved: false` with the
  reason.
- **An error message could carry a credential.** A fetch failure quoting a URL
  with a token in it propagated into the thrown error's message and `cause`. Text
  from outside is now redacted, and no `cause` is attached to a network error: the
  stack is not worth a credential.

## What is deliberately not done yet

- Nothing has run against the **production** ModelPilot service — only the mock.
- The zero-token planning ratio is still not instrumented, which is the number
  that decides whether `enforce` is affordable per household.

---

## Amendment, 2026-08-31 — the service is a router, not a decision engine

The first-stage integration was built against a ModelPilot that does not exist.
Reading the service's own source settled it: it is a **cost-aware model routing
control plane** whose primary metric is Cost Per Successful Task, and its public
API is `GET /v1/models`, `POST /v1/chat/completions` (OpenAI-compatible, with
`model: "auto"` as the routing trigger) and `POST /v1/feedback`. There is no
`/v1/tasks/execute`, no task or trajectory id, no `dataPolicy`, and no MCP.

**Every decision above holds.** ModelPilot is still a planner behind the same
seam (1); still REST, though 2 is now a weaker decision because there is no MCP
surface to weigh it against; shadow is still the default and no key still means
off (3); availability may still fall back and an unusable answer still may not
(4); minimisation is unchanged and is now the *only* privacy mechanism in the
request (5); the key is still never a URL flag (6). What changed is the transport
and three things underneath it.

### What the correction changed

1. **`decideExecution` / `executeVerifiedTask` → `complete`.** One
   OpenAI-compatible POST. `getTaskEvidence` and `getTaskTrajectory` are deleted
   rather than left unused: they addressed endpoints that were never there.
2. **`evaluation_status` is not a gate.** The service reports `unverified` on
   every fresh completion by design — CST does not count a task successful until
   a verifier confirms it — and the planner was reading that as "the engine does
   not stand behind this answer" and refusing to act. In enforce mode that
   blocked **every call it would ever have made**. Three questions are now three
   questions: is the answer usable (`parseActionPlan`), did the television do it
   (the local read-back), does ModelPilot count it successful (`/v1/feedback`).
3. **The unenforced policy block is gone.** `dataPolicy`, `requirements`,
   `strategy`, `economics` and `verification` were sent on every request and read
   by nobody. A retention guarantee in a field the server ignores is worse than
   no guarantee, because it reads like one; a test now asserts they are absent.
   The real boundary is `minimiseRoomState`, which is a mechanism rather than a
   sentence.

### What it found

- **The mock was the reason nobody noticed.** Forty-six tests were green against
  a protocol nobody speaks, because `tools/mock-modelpilot-server.mjs` was
  written from the same misreading as the client. A mock is a claim about
  somebody else's server; when it is wrong it does not fail, it agrees with you.
  The lesson worth keeping: a mock of a third-party API has to be derived from
  that API's source, its OpenAPI document or a recorded transcript — never from
  the integration's own idea of it.
- **A 200 can be a non-answer.** A routing layer optimises for score, price is
  part of that score, and a model too weak to hold a schema does not fail loudly
  — it answers the question in prose. Nothing in the stack calls that an error
  until it reaches the parser, and the parser's no-repair rule paid for itself
  the first time. `metadata.quality_threshold: 0.85` is the other half: it keeps
  the weak end of a catalogue out, and turns "nothing qualifies" into an honest
  422 rather than a round trip spent discovering it.
- **A timeout was reporting as `unreachable`.** `controller.abort(reason)` makes
  Node's fetch reject with the reason rather than an `AbortError`, so the name
  check missed it. Unit tests could not see this — they throw a properly named
  `AbortError` — and only the end-to-end run against `--answer slow` printed the
  two-diagnoses-in-one-line version. The controller is now asked instead of the
  error being inspected.

### 7. The television is ModelPilot's verifier, and says nothing when unsure

`POST /v1/feedback` takes `{ request_id, success, score? }`, and ModelPilot's own
documentation says a completed API call is not a successful task until a verifier
confirms the outcome. **This runtime is that verifier**, and a better one than
user feedback: it read the device back.

`verified` → `success: true`. `failed` → `success: false` — the row the whole
integration exists to produce, an answer the router billed for that did not work
on real hardware. `unverified`, `unsupported`, policy-`denied`, `ask_user`, and
**every shadow-mode plan** → nothing is posted at all.

That last group is the decision, not an omission. A metric is only worth anything
if its denominator is honest, and a runtime that reported its own uncertainty in
either direction would be quietly making CST worthless. The same rule that makes
this runtime refuse to say `verified` about a television it cannot read makes it
refuse to say `success` about an answer it cannot judge. How often that happens
is recorded (`local_final_verification: "not_run"`), because the size of the gap
is a fact worth having.

Wiring is one line at the host — `agent.events.on("plan:end", ({ outcome }) =>
planner.report(outcome))` — and a failed report is telemetry, never a device
problem.

### What is unresolved and blocks a fleet

ModelPilot is BYOK and its Free plan counts 1000 requests a month **per tenant**;
`x-hearth-install` does not participate in that count. One key across a fleet
means one heavy household spends the month for every television on that key.
Either a key per device (provisioning) or per-install accounting in the Worker
(a service change) has to land before this is enabled on more than one TV.
