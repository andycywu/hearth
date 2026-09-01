# Counting televisions without watching living rooms

**The shape:** Hearth is a free, open agent runtime. ModelPilot is the service.
A service business has to know how many devices use it and how often — that is
not optional, and it is not surveillance. But the difference between the two is
one design decision wide, so this page states which side of it each choice is on.

## The rule that makes this work

**The runtime does not phone home. The backend counts what it already receives.**

ModelPilot is the only egress this runtime has, and a host opts into it by
configuring a credential. So the metric question is answered *server-side*, from
calls that were happening anyway:

```
                       nothing is sent
MODELPILOT_MODE=off ──────────────────────►  (no signal, and that is correct)

MODELPILOT_MODE=shadow|enforce
      │
      ▼
  ModelPilot request
      ├─ authorization: Bearer …        which customer / OEM
      ├─ x-hearth-install: hth_…        which installation (random, resettable)
      ├─ x-hearth-runtime: 0.2.0        which runtime version
      └─ x-hearth-mode: shadow          which mode
      │
      ▼
  ModelPilot already has: a timestamp, a request id, a selected model, a cost
      │
      ▼
  enforce only, once the television has finished:
  POST /v1/feedback { request_id, success }   ← did the answer actually work
```

From those, entirely server-side and with no new endpoint:

| Question | How |
|---|---|
| How many installs are active? | distinct `x-hearth-install` in a window |
| How often does one use the service? | calls per install per day |
| Are they upgrading? | `x-hearth-runtime` distribution |
| Who is in shadow vs enforce? | `x-hearth-mode` |
| Which customer or OEM? | the API key the call was made with |
| What does it cost us per install? | `actual_cost` per install |
| **Does a given model's answer actually work on a TV?** | `/v1/feedback` success rate grouped by `selected_model` |

**There is no analytics client, no event queue and nothing to disable** — because
there is nothing extra being sent. That is the property worth protecting: it is
what lets the runtime stay honestly free and offline while the service still has
a business.

One call does not come from the runtime's own work: `POST /v1/feedback`, in
enforce mode, once the television has finished with a plan. It is worth being
precise about why that is not a hole in the rule. It carries a request id the
service issued and one boolean, it exists only for calls the host already opted
into, it is the mechanism ModelPilot's own primary metric is defined in terms of
— and it is *silent* whenever this runtime cannot be certain, which is often. It
is the answer to "did the thing you billed me for work", not a report on a
household. See
[modelpilot-integration.md](modelpilot-integration.md#closing-the-loop-the-television-is-modelpilots-verifier)
for the full table of what is and is not said.

## What the install id is, and is not

`loadInstallId` ([`core/src/identity.ts`](../packages/core/src/identity.ts)):

- **Random, generated on the device, stored locally.** `hth_` plus 16 random
  bytes.
- **Not a hardware identifier.** Not the Android ID, not a serial number, not a
  MAC, not an advertising id. Two identical televisions in the same shop get two
  different ids, and [a test asserts it](../packages/core/src/identity.test.ts).
- **Resettable.** `resetInstallId` issues a new one; the old one is gone. A
  household that wants to be a new installation can be.
- **Carried only on ModelPilot calls.** No key, no calls, no id.
- **Replaced if something else is found in its slot** — a stored value that is
  not one of ours (an Android ID somebody helpfully cached there) is discarded.

Known limitation, stated rather than buried: a device whose storage is
unavailable gets an **ephemeral** id and counts as a new install every boot. That
overstates device count. If the numbers ever look implausibly high, this is the
first thing to check.

## What it cannot tell you

- **Devices that never call.** `off` mode, or a runtime running against a local
  model with no ModelPilot key, is invisible. For an open-source free runtime that
  is a feature; for a "how many TVs run Hearth" number it is a hard ceiling. The
  honest phrasing is **service usage**, never install base.
- **Anything about a household.** No content, no room state, no occupancy, no
  transcripts — see [modelpilot-integration.md](modelpilot-integration.md) for the
  minimisation allowlist and its tests.
- **One device vs one person.** An install id is a television, and a television is
  a household.

## What a call costs, per television

The planning meter turns the ratio into money: `agent.planning.project({ turnsPerDay })`
uses ModelPilot's own reported `actual_cost` when there is one and says so
(`costBasis: "measured"`), falls back to a stated assumption when there is not,
and never returns a number without the assumption attached.

```
0.2 model-backed share × 10 turns/day × $0.002 = $0.004/day = $1.46/device/year
```

Against European smart-TV platform ARPU in the single-digit dollars, that is the
line item to watch — and the deterministic planner is what keeps it small. The
four P0 scenarios currently plan for **100% zero tokens**; the number that matters
is what real utterances score, which is a device-report question rather than a
code question.

## Two things to fix before this is a product

**1. "Zero retention" was never enforced, and now is not claimed.** The runtime
used to declare `retentionRequirement: "zero"` on every request. Nothing on the
service side read it — see the
[ADR-0004 amendment](adr/0004-modelpilot-boundary.md) — so the declaration has
been removed rather than left reading like a guarantee.

That does not make the question go away, it relocates it. ModelPilot's own
position is that prompts are not stored by default and a SHA-256 request hash
supports correlation without retention; what it *does* store per call is
metadata — timestamps, tenant, selected model, cost. So the policy that has to be
written down, in ModelPilot's docs and in whatever an OEM's privacy notice says,
is: zero retention of task **content**, bounded retention of request
**metadata**. Both claims can be true; neither is currently stated where a
data-protection review would look.

**2. GDPR basis and retention.** A pseudonymous install id plus usage timestamps
is personal data under GDPR — pseudonymous is not anonymous — and Titan's market
is Europe. That needs a stated lawful basis (legitimate interest or contract), a
retention period for the raw per-call rows (aggregate and drop, rather than keep
forever), a documented reset path, and a line in the privacy notice the OEM ships.
None of that is code; all of it is a prerequisite to switching a fleet on.

## What this repo promises, and what changed

`CONTRIBUTING.md` refuses "telemetry, analytics, or anything that phones home".
That promise stands, and it is now more precise:

> The runtime makes no network call the host did not configure. ModelPilot calls
> are configured by the host, carry a pseudonymous install id so the service can
> count usage, and are the only egress. There is no separate analytics endpoint,
> no hardware identifiers, and in `off` mode nothing is sent at all.

A contribution that added an analytics client, a hardware identifier, or a call
the host did not configure would still be refused.

## The free-runtime / paid-service split

Worth writing down, because it decides what belongs where:

| | Hearth (free, Apache-2.0) | ModelPilot (the service) |
|---|---|---|
| Agent loop, world model, capability graph, device graph | ✅ | — |
| Planning that a device can do for free | ✅ deterministic, zero tokens | — |
| Planning that needs model intelligence | optional local model | ✅ the product |
| Device control, verification | ✅ always local | never |
| Usage metering, billing, evidence, trajectories | — | ✅ |
| Fleet policy, quotas, per-OEM configuration | — | ✅ |

The thing to keep on the free side is everything a television needs to work when
the service is unreachable. That is what makes the runtime worth adopting, and
adoption is what makes the service worth selling. A runtime that stops working
without the backend is not a free runtime; it is a demo with a subscription.
