# ADR-0004 — ModelPilot decides; the television verifies

_Status: accepted, 2026-08-27. First-stage integration._

## Context

ModelPilot is an execution decision engine reachable over REST and Remote MCP. We
want the steps that need model intelligence — planning, reasoning, content
understanding — to go through it, while the physical operations stay where they
already work: the local HAL, the adapters, CEC and IR.

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
engine, records the suggestion and the trajectory id, compares it with the local
plan, and **runs the local plan**: device behaviour identical to `off`.

A missing API key forces `off` regardless of the requested mode. The default mode
*calls a cloud service*, and a television doing that with no credential
configured would be both noisy and wrong. Configuring the key is the opt-in.

### 4. Availability failures may fall back; unusable answers may not

An unreachable engine, a timeout, a 5xx or a rejected credential is our problem
to route around: enforce falls back to the local planner and records why
(`onUnavailable: "refuse"` for a host that would rather stop).

An engine that **answers** with something unusable — a plan missing required keys,
or a task it reports unverified — gets no fallback. Substituting our own plan
would replace the accountable answer with an unaccountable one. Those return an
empty plan carrying the task and trajectory ids, which sends the agent to recovery
or to the user.

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
  The response schema and the `decideExecution` mapping are assumptions, marked as
  such in `client.ts`.
- `getTaskEvidence` / `getTaskTrajectory` are implemented and unused.
- The zero-token planning ratio is still not instrumented, which is the number
  that decides whether `enforce` is affordable per household.
