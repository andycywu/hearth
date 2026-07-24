# Contributing

Thanks for your interest! This project is open source under Apache-2.0.

## Dev setup
```bash
corepack enable pnpm
pnpm install
pnpm build && pnpm test
```

## Ground rules
- The **core** (`packages/core`) must stay platform-agnostic — no `tizen.*`,
  no Android bridge, no DOM assumptions beyond the ES2020 baseline.
- New device capabilities go through the HAL: extend `platform-api`, implement
  in **every** adapter, add a contract test, then expose a tool in the core.
- Keep changes small and focused; add/adjust tests; run `pnpm lint` and
  `pnpm typecheck` before opening a PR.
- By contributing you agree your contributions are licensed under Apache-2.0.

## Commit / PR
- Conventional, descriptive commit messages.
- CI (typecheck + test + lint) must pass. Note any device testing you did.
