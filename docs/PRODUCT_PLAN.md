# Product Plan

What Hearth is trying to become, who it is for first, and the order in which
that happens. The software roadmap lives in [`roadmap.md`](roadmap.md) and the
platform bring-up plan in [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md); this
document is about the product and the people around it. For what is actually
built and verified today, read [`STATUS.md`](STATUS.md) first.

_Written 2026-10-04, at v0.3.0. Revisit at every milestone exit._

## The finding this plan is built on

The README calls it "the finding that shaped this project": a third-party app
on Android TV, Tizen or webOS cannot switch inputs, cannot put the set in
standby, and cannot reach most of what makes a living-room agent worth having.
It gets volume, mute and app launch — and the platform's own assistant already
does those. **The capabilities that matter belong to whoever holds the signing
key.**

That finding closes one door and opens two.

- The closed door is a consumer app in a TV store. The repo reached that
  conclusion on its own and this plan does not reopen it.
- The first open door is **HDMI-CEC from a device beside the television**. It is
  the one path in this repository that switches inputs, changes power and talks
  to a second device without anyone's signature, and on 2026-09-16 a Raspberry
  Pi 3B read a real bus through it. An independent product's first form is a
  small box next to the TV, not an app on it.
- The second open door is **a platform that holds its own key**. For a TV OS
  vendor, Hearth is a runtime that already answers `verified / unverified /
  unsupported / failed` for every action, with the privileged half unlocked by
  platform signing. That is a different product with a different buyer, and it
  is pursued in parallel, not instead.

## What Hearth is, in one sentence each

**For a person with a Raspberry Pi and a living room:** a hub that learns what
your television and the things plugged into it can actually do, does what you
ask, and tells you plainly when it could not.

**For a TV platform or OEM:** a cross-OS agent runtime with an honest read-back
contract, a capability graph, and a verification report per device — the part
of a TV assistant that is the same on every operating system, so you do not
build it five times.

**For a developer:** a place where a skill can know, before it runs, whether the
capability it needs is `verified` on this device — because someone's living
room already reported it.

## The flywheel

Two wheels, one shared asset.

The **community wheel**: living rooms run `?diag` and `verify-cec` → the
[Hearth Report](platform/capability-matrix.md) covers more devices → skill
authors know where a capability is `verified` and write for it → more skills
give more reasons to install → more living rooms report.

The **business wheel**: the capability matrix becomes the only public record of
what televisions really do → OEMs and silicon vendors want their devices on it
as "Hearth Verified" → verification and integration are paid work → preloads and
adapter integrations grow the installed base → hosted planning, metered per
device, has the scale to matter.

The shared asset is the capability matrix. Every decision below is judged by
whether it makes that matrix bigger, more trustworthy, or more useful.

## Who first

**Home Assistant and Raspberry Pi people.** They already own the one thing this
repository could not verify alone — a CEC bus with a console or an AVR on it.
They are used to filing compatibility reports. The roadmap's P2 already names
Home Assistant as a capability provider. They are also the audience most likely
to appreciate an agent whose selling point is that it refuses to lie.

The first product for them is **Hearth Hub**: a one-line install on a Pi (and
later a Home Assistant add-on) that runs `hearth setup`, produces a
`hearth report`, and lets a stranger get from an unboxed Pi to a first
successful command in fifteen minutes.

## Milestones

Each milestone has an exit condition. A milestone is done when the condition
is met, not when the work feels finished.

| | Milestone | Exit condition |
|---|---|---|
| **M0** | Housekeeping (≈1 week) | `v0.3.0` tagged; stale branches gone; README, STATUS and roadmap agree on every number; this document exists; GitHub Discussions open. |
| **M1** | Hearth Hub (≈4 weeks) | One-line install on a Pi, `hearth setup`, `hearth report`. A stranger installs and issues a first command inside fifteen minutes. |
| **M2** | The second device (≈3 weeks, parallel with M1) | "Switch to the PS5" on a real CEC bus with every step `verified`; the transcript lands in a fixture. Precondition: a console, Blu-ray player or AVR on the bus. |
| **M3** | One-click reporting (≈2 weeks) | `hearth report --submit` opens a GitHub issue; an Action folds it into the Hearth Report. Discord exists. Good-first-issues are labelled and real. |
| **M4** | Public launch (1 week) | HA forum → Reddit → Show HN → Tizen/webOS forums, one per day. Exit: five living rooms that are not the author's, three televisions the author does not own, on the matrix. |
| **M5** | The deep end (≈3 months) | World Model persistence, opt-in diagnostics, manifest update channel, hosted planning with keys and quota, HA add-on, wake word, on-TV settings UI, npm publish. Exit: a Hub runs unattended for a month. |
| **M6** | Platform / OEM track (parallel) | Internal alignment with a design partner; MTK board plus platform signing; `TitanBridge` replacing the stub; a first platform device report; a written definition of "Hearth Verified". |

M6 is the second door. It runs beside the others because its calendar is set by
hardware, signing and other people's roadmaps, none of which this repository
controls.

## Where the money is, and where it is not

Open, Apache-2.0, forever: core, the HAL, the CEC transport, the Linux adapter,
the report tooling. These are the flywheel's axle and they stay free.

Paid, in this order:

1. **Hosted planning and model routing.** A free tier, then a per-device
   subscription. ModelPilot already exists; what is missing is per-device keys,
   quota, and multi-tenancy — the shipping blocker named in `STATUS.md`.
2. **The OEM layer.** Privileged adapter integration, "Hearth Verified"
   certification, support contracts. The first design partner is a TV platform
   whose team overlaps with this repository's author.
3. **Later, a skill marketplace** with revenue share — only once there are
   enough living rooms for a marketplace to mean anything.

The community wheel turns first. OEM conversations are easier with a public
matrix behind them than with a slide deck.

## Metrics

Five numbers, reviewed at each milestone exit.

- Devices on the capability matrix.
- New reports per month.
- Pull requests from people who are not the author.
- Times a device that is not the television has reported `verified`.
- Longest unattended Hub uptime, in days.

## Assumptions, stated so they can be wrong

- This is an independent open-source project with a single maintainer and a
  design partner, at roughly ten hours a week. Milestones are sized for that.
- Hardware on hand is a Pi 3B, one HKC Tizen 7.0 television and a ReSpeaker
  array. There is no second CEC device yet; M2 waits on one.
- The first users will tolerate a command line. The ones after them will not,
  which is what M5 is for.
- Zero telemetry stays the default. Diagnostics are opt-in or they do not ship.

## Open questions

- Internal platform product first, or independent project first? This plan
  says both, in parallel, with the community wheel leading — but that is a
  bet, not a fact.
- Where exactly is the open-source boundary? Core open and platform adapters
  proprietary is the working answer; it has not been tested against a real
  partner contract.
- Cloud, on-device, or hybrid planning? A 1.5B model can take one step and
  cannot chain tools. The answer needs latency and cost numbers from real
  hardware, which M6 is the first place to get.
