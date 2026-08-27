# Ten ways in

Ready to paste into GitHub as issues when the repo moves. Half need no hardware
at all; two need only a browser. Each says what "done" looks like, because a
good-first-issue that ends in a debate about scope is not one.

Ordered by how quickly you would see your own work running.

---

## 1. A scenario nobody has written — *no hardware*

**Labels:** `good first issue`, `skills`

`core/src/skills/scenarios.ts` has six: switch input, gaming session, movie
night, night mode, quieter, louder. Missing and obvious: `kids_mode`,
`sports_mode`, `music_mode`, `meeting_mode`, `leave_home`.

A scenario is data — a goal expressed as desired world state, plus optional
niceties that degrade when a device cannot do them. **No platform-specific code
is allowed in one**; if yours seems to need some, the Capability Graph is missing
an entry and that is the more interesting bug.

**Done:** the skill, a test in the style of `plan-mode.test.ts` proving it plans
on the mock adapter, and one line in the skills table in
[`agent-planner.md`](agent-planner.md).

---

## 2. A skill manifest for something real — *no hardware*

**Labels:** `good first issue`, `skills`

`packages/skill-manifest` interprets JSON: one HTTP request, a response mapping,
an origin allowlist the manifest cannot widen. There is one example (weather).
Sports scores, transit times, air quality, a smart-home bridge — all the same
shape.

**Done:** the manifest under `packages/skill-manifest/examples/`, a test that
mocks fetch, and a note in [`skills.md`](skills.md).

---

## 3. Make `describe()` speak the user's language — *no hardware*

**Labels:** `good first issue`, `i18n`

`summarizeOutcome()` in `core/src/planner/report.ts` produces mechanical English
("Done: tv.audio.set_volume(level=30).") while the agent otherwise replies in
whatever language the user used. Two possible shapes, and the PR should argue for
one: a string bundle per locale, or an `agent.explain(outcome)` that hands the
outcome to the model and falls back to the mechanical string offline.

**Done:** Chinese and Japanese come out right, the offline path still works with
no model, and the existing tests still pin the honest distinctions —
`unverified` must not become "done" in any language.

---

## 4. A perception source with a real signal — *no hardware, or a webcam*

**Labels:** `good first issue`, `perception`

`packages/perception-mock` emits scripted events. A source that derives occupancy
from something real — a webcam via `getUserMedia`, a Bluetooth presence scan, a
Home Assistant sensor — would be the first non-scripted one.

Read [`policy-and-safety.md`](policy-and-safety.md) first. The gate strips raw
frames, transcripts and identity fields from every event, and the PR must not
try to widen it. If your source needs a face embedding to cross, the answer is
no.

**Done:** the source, a grant that has to be given before it starts, and a test
proving nothing raw survives the boundary.

---

## 5. Device reports from anything with a screen — *needs a TV*

**Labels:** `good first issue`, `device-report`

The [Hearth Report](platform/capability-matrix.md) has four devices, three of
them emulators. Every retail television is new information. Fire TV, Roku,
Vidaa, Titan OS, an old Android TV box, a Chromecast with Google TV — all
unknown here.

**How:** `node tools/device-report.mjs` on Android TV, or
`(await window.__hearthReport({ allowWrites: true })).markdown` in the WebView
console anywhere else. Both produce the finished section.

**Done:** an issue using the Device report template, or a PR adding a section to
the Hearth Report. A failure is a result: "would not install, here is the error"
is worth posting.

---

## 6. Promote Blits to the default renderer — *browser only*

**Labels:** `ui`, `help wanted`

`apps/blits-demo` is a Lightning 3 / Blits WebGL renderer wired to the same
agent events. It has never been promoted into `packages/ui` as the default with
a DOM fallback, because that needs GPU testing on a low-end TV — which is
exactly what a contributor with a cheap Android TV box can do and we cannot.

**Done:** `mountAgentBlits` in `packages/ui` behind the shared view-model, a
fallback when WebGL is unavailable, and a note about the hardware you tested on.

---

## 7. HDMI-CEC discovery — *needs hardware, and it is the big one*

**Labels:** `help wanted`, `hardware`

The Device Graph has a `hdmi_cec` discovery source in its design and nothing
implementing it. This is the single change that would turn "I don't know where
your PS5 is" into a room the agent can actually see.

Expect resistance from the platform: CEC is privileged on most Android builds.
Start by reporting **what your device exposes**, before writing an adapter — that
alone is a valuable issue.

**Done:** even a negative result. "On this box, `HdmiControlManager` requires a
system signature, here is the exception" is a contribution.

---

## 8. Commit hygiene: build output is in git — *no hardware*

**Labels:** `good first issue`, `chore`

`apps/aosp-app/app/build/`, `apps/aosp-app/.gradle/`, `.idea/` and
`apps/tizen-app/Debug/` are committed build artefacts and IDE state. They should
be ignored and removed from the tree.

Careful: `apps/tizen-app/Debug/` contains a *signed* manifest, and the packaging
script regenerates it. Removing it must not break `pnpm package:tizen`.

**Done:** `.gitignore` updated, the directories removed, packaging still works.

---

## 9. A wider capability tree — *needs a TV that has these*

**Labels:** `help wanted`, `capabilities`

The Capability Graph declares picture mode, HDR, backlight and audio profile in
its documented tree; none of them are implemented, because there is no
non-vendor API for them. If your TV exposes any — through a vendor SDK, a Luna
service, a `tizen.*` namespace — one capability plus one handler is the whole
change, and `movie_night` immediately gets better.

**Done:** the capability entry (with `riskLevel` and how it is verified), the
handler in the relevant adapter, and a device report showing it working.

---

## 10. Make the zero-token ratio measurable — *no hardware*

**Labels:** `good first issue`, `instrumentation`

The deterministic planner handles known intents with **no model call at all**;
the LLM planner is only consulted for the long tail. Nobody knows the ratio,
and on a television that ratio is the difference between a product and a demo:
inference cost per turn against a platform ARPU of a few dollars a year.

**Done:** a counter on the agent (planned deterministically / planned by model /
chat), exposed on the event bus, printed by `?diag`, and a line in the bench
output. No telemetry — local counters only.

---

## Not on this list

Content search, recommendation, a launcher, telemetry, or anything that widens
the perception boundary. See the refusal list in
[`CONTRIBUTING.md`](../CONTRIBUTING.md) — it is short on purpose, and it is
firm.
