# Working in this repo

Read, in order: `README.md` → `docs/STATUS.md` → `docs/PRODUCT_PLAN.md` →
`docs/internal/HANDOFF.md`. STATUS is the file that is kept true; if anything
disagrees with it, STATUS wins. `CHANGELOG.md` `[Unreleased]` says what has
landed since the last tag — read it before assuming something is still open.

## The one rule

Every action reports `verified / unverified / unsupported / failed` and the
runtime never claims it did something it cannot read back. Code, tests, docs
and commit messages all hold to that: say what was checked, not what was hoped.

## Toolchain

- Node **≥ 26** (`.nvmrc`), pnpm 9 (`packageManager`). TypeScript 6, vitest 2.
- Gate before any commit: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`,
  and `pnpm bundle:all && pnpm check:size` when anything under `packages/` changed.
  Nothing is committed red.
- `pnpm test` runs every package; the total test count appears in README,
  `docs/STATUS.md` (with a per-package breakdown), `docs/roadmap.md`,
  `CONTRIBUTING.md`, `docs/BRINGUP_CHECKLIST.md` and `docs/internal/HANDOFF.md`.
  Update all of them when the number changes.
- Zero runtime dependencies. Do not add one.

## Conventions

- Commits: `type(scope): a sentence that says what changed and why`, body in
  prose, ending with the test count. Read `git log` for the voice; it is
  deliberate. Co-author trailer for Claude as in recent commits.
- Tests substitute the outside world through an injected `Runner`
  (`adapter-linux/src/run.ts`), `readFile`, `exists`, or a fake
  `VoicePipeline`; they never spawn real tools. Record real tool output in the
  fixture when adding one (see `voice.test.ts`, `host.test.ts`).
- Docs are prose, in the repo's voice. A new capability gets a CHANGELOG entry
  that says what was learned, not just what was added.
- Secrets never touch a file git can see, a command line, or a unit file.
  `TV_AGENT_API_KEY` lives in the environment or `~/.config/hearth/env` (0600).

## Layout that matters for the Hub work (M1)

- `apps/cli` — `hearth`: `main.ts` (wiring), `args.ts` (flag > env > config),
  `config.ts` (`~/.config/hearth/config.json`), `setup.ts` (`hearth setup`),
  `report.ts` (`hearth report`), `room.ts` (discoverRoom → attachTransports,
  CEC), `voice-loop.ts` (microphone → attention word → `answer()` → ring),
  `wake.ts`.
- `packages/adapter-linux` — the Pi: `audio.ts`, `cec.ts` (cec-ctl),
  `voice.ts` (arecord / espeak-ng / OpenAI-schema transcriber / silence gate),
  `leds.ts` (APA102 ring), `host.ts` (device identity).
- `packages/adapter-cec` — the CEC transport, `createCecTransport(bus)`.
- `tools/pi-first-report.sh` runs the whole first-report flow on a Pi;
  `tools/pi.ps1` drives it from Windows (`$env:HEARTH_PI`, `$env:HEARTH_TV`).
- `docs/platform/reports/` — one Hearth Report per device, generated, never
  hand-edited except for a dated note at the end.

## Boundaries

- The Titan OS adapter (`packages/adapter-titan`) is a stub by design. Anything
  learned from a Titan OS development build — shell commands, internal APIs,
  paths, protocol details — is **not** committed to this public repository.
  It goes in a private repo; this repo gets only the abstract layer
  (`DeviceTransport`, `PlatformProvider`, report format) and a capability
  matrix row that says the device was verified without saying how. See
  `docs/PRODUCT_PLAN.md`, "Where the money is".
- Private operational details (LAN addresses, hostnames, who owns what) belong
  in `CLAUDE.local.md`, which is git-ignored.
