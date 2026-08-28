# ADR-0003 — The project is called Hearth; its namespaces are `hearthkit`

_Status: accepted, 2026-08-18._

## Context

The project shipped as `tv-ai-agent` with an `@tv-ai-agent/*` package scope. That
name is descriptive, which sounds like a virtue and is not: it cannot be
trademarked, cannot be searched for, and — the part that actually matters — it
cannot *generate vocabulary*. If the capability-graph ideas here are ever adopted
by anyone else, they will be adopted under whatever words we gave them, and
"tv-ai-agent" gives them none.

Two constraints came from outside the code:

- **Do not bind the name to Titan OS.** An open-source project carrying a
  company's product brand reads as an official support commitment, and it makes
  separating the project from any future product expensive.
- **Nothing is published yet.** `@tv-ai-agent/core` is a 404 on npm, so this was
  the last free moment to change every name at once.

## Decision

**The project is Hearth** — the fire a room is arranged around, and the oldest
metaphor there is for the centre of a home. It says "living room" without saying
"TV", which matches a runtime where the television is one device among several.

**Every namespace that must be globally unique is `hearthkit`.** This is the
`vuejs` / `nodejs` pattern: brand word in prose, brand word plus suffix where a
registry demands uniqueness.

| Where | Name |
|---|---|
| Prose, docs, README, spoken | **Hearth** |
| npm scope | `@hearthkit/*` |
| GitHub org (when the repo moves) | `hearthkit` |
| Domain (when bought) | `hearthkit.dev` |
| CLI command | `hearth` |
| Skill scaffolder | `npm create hearth-skill` |
| Storage namespace (localStorage, SharedPreferences, XDG dir) | `hearth` |

Tagline: *an AI agent runtime for smart TVs and living-room devices. Cross-OS,
verified, and it never claims to have done something it didn't.*

## Why `hearthkit` and not `hearth` everywhere

Checked on 2026-08-18:

| Asset | State |
|---|---|
| npm `hearth` | taken — a dormant 2015 test-data generator |
| npm scope `@hearth` | no published packages; org page returns 403, so claimability is unverified |
| GitHub org `hearth` | taken — created 2019, zero public repos, points at `hearth.lol` |
| `hearth.dev`, `hearth.tv`, `hearth.io`, `hearth.software`, `hearth.systems`, `hearth.run` | all registered |
| `hearthside`, `mantel` (the runners-up) | GitHub org and `.dev` both taken |
| **`hearthkit`** | npm package free, `@hearthkit` scope free, GitHub org free, `hearthkit.dev` free |

`hearthkit` was the only candidate free on all four. Consistency across four
registries is worth more than one word of elegance in an import path.

## The trademark risk, stated plainly

**[Hearth Display](https://hearthdisplay.org/)** is a funded company (~$14M
raised, ~30 staff) selling a **smart family display for the home** — the same
conceptual space as ours: home, screen, family. There is also a "Hearth Smart
Home Dashboard" app, and "Hearthstone" dominates search results for the word.

For a developer-facing open-source project this is acceptable: we are not filing
a mark, not selling to consumers, and not competing for their customers. **It is
not acceptable as a consumer product brand without legal review** — EUIPO/USPTO
class 9 was not searched and should be before anyone puts this name on a product.
That review is a prerequisite, not a formality.

## Deliberately not renamed

- **Android `applicationId` `tv.aiagent.harness`**, and the Tizen/webOS app ids.
  Renaming an app id changes the installed application's identity: it invalidates
  every documented `adb shell am start …` line, and every device with the old
  build installed keeps it alongside the new one. Worth doing once, on purpose,
  with the docs updated in the same change — not as a side effect of a naming
  pass.
- **`local-tv-agent`**, the default model id in `llm-connectors`. That names a
  *model*, not this project, and it is asserted in tests and documented for local
  inference. Churn without value.
- **`apps/tizen-app/Debug/**`** — committed build output including a signed
  manifest. Editing a signature file by hand invalidates it; `pnpm package:tizen`
  regenerates it. (That directory should not be in git at all; separate cleanup.)
- **The GitHub URLs in `README.md` and the dev harness.** They point at the repo
  as it exists today. They change when the repo actually moves, because a dead
  link in a demo is worse than an old one.
- **CHANGELOG history.** Past entries record what was true when written.

## Consequences

- One-time storage break: anything already written under the `tv-ai-agent`
  prefix — conversation history, installed skills, the device graph — is
  invisible to the new build. Pre-release is the only moment that costs nothing;
  the same edit after a device ships needs a migration per key.
- 114 files rewrote their imports; the 614-test suite, all six adapter targets,
  lint, typecheck and every bundle pass unchanged, which is the evidence that the
  rename was mechanical.
- The npm scope and GitHub org still have to be *claimed*. Until they are, the
  names are only reserved by intent.

### Update, 2026-08-28 — the repository moved

The deferred half of this decision is done: `andycywu/tv-ai-agent` is now
`andycywu/hearth`, and the URLs this ADR deliberately left alone have been
rewritten in `README.md`, the dev harness, `CHANGELOG.md`, the `create-skill`
template and the SBOM's vendor field. `repository`, `homepage` and `bugs` are
declared in the root `package.json` for the first time, so the link exists in
metadata and not only in prose.

`hearth` rather than `hearthkit` for the repository: `Hearth` is the product and
the README's title, while `@hearthkit/*` is the package namespace. One is what it
is called; the other is where its code is published.

Two things this costs, both accepted:

- **The GitHub Pages demo URL changed** to `andycywu.github.io/hearth/`. GitHub
  redirects a renamed repository's own URLs, but not its Pages site, so the old
  demo link is dead rather than forwarded. It was the README's headline
  call-to-action, which is why it was worth doing before anyone links to it.
- **Git remotes elsewhere keep working** — GitHub redirects those — but any
  clone still pointing at the old name should be updated with
  `git remote set-url origin https://github.com/andycywu/hearth.git`, because a
  redirect is a courtesy and not a contract.

The npm scope and a GitHub organisation are still unclaimed.
