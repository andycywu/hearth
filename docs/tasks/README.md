# Task specs

Detailed, executable specs for the remaining work. Each file is self-contained:
context → files to touch → step-by-step → code sketches → acceptance →
verification. Do them in order; keep the repo green after each.

**Green gate (run after every task, before committing):**
```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm bundle:all && pnpm check:size
```

## Group A — no hardware (do first)
- [x] [A1 — Verify the Android host builds](A1-verify-android-build.md) — done: wrapper
  added, APK builds, theme + package-visibility bugs fixed.
- [A2 — Extract a shared view-model; make Blits a first-class renderer](A2-blits-ui-package.md)
- [A3 — Raise test coverage](A3-test-coverage.md)
- [A4 — Wire voice + confirm into device app entries](A4-device-entries.md)
- [A5 — Skill tutorial + example skill](A5-skill-tutorial.md)
- [A6 — Nice-to-haves (badges, bench, i18n)](A6-nice-to-haves.md)

## Group B/C/D — need emulator / browser / release
See [`HANDOFF.md`](../../HANDOFF.md), [`docs/EMULATOR_SETUP.md`](../EMULATOR_SETUP.md),
[`docs/BRINGUP_CHECKLIST.md`](../BRINGUP_CHECKLIST.md), [`docs/RELEASING.md`](../RELEASING.md).

## Conventions reminder
- Core stays platform-agnostic; new capability → `platform-api` → every adapter →
  contract test → tool. See [`docs/extending.md`](../extending.md).
- Test files are excluded from package builds (per-package `tsconfig` `exclude`).
- Update `CHANGELOG.md` (Unreleased) and check the box here when done.
