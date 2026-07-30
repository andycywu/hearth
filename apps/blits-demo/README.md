# Blits (WebGL) demo — standalone

A Lightning 3 / **Blits** UI for the agent, rendering entirely on the GPU canvas.
This is the production path for low-end MTK/NVT GPUs (vs. the DOM overlay / 2D
canvas renderers in `packages/ui`). The agent-event wiring is identical — only
the view layer differs.

> **Standalone on purpose.** This app is *not* part of the pnpm workspace or CI,
> so Vite + Blits don't bloat the main install. It has its own `node_modules`.

## Build & run

```bash
# 1. Build the agent packages first (produces the dist/ this demo aliases to)
pnpm -w build            # from the repo root

# 2. Install and run this demo separately
cd apps/blits-demo
npm install
npm run dev              # http://localhost:5173  (Vite)
npm run build            # production WebGL bundle in dist/
```

On boot it runs a short scripted sequence so you can see tokens/tool activity
streaming into the WebGL scene; press OK/Enter (or Right) to replay. Real input
would come from the voice pipeline or the remote.

## How it maps to the rest of the repo
- `createWebAdapter()` + `createScriptedClient()` — same offline stack as the dev
  harness; swap in a device adapter + `createOpenAiCompatibleClient` for real use.
- The Blits component consumes `createAgentViewModel(agent)` from
  `@tv-ai-agent/ui` — the very same tested view-model behind `mountAgentOverlay`
  and `mountAgentCanvas` — and maps its state onto Blits reactive properties.
  There is no duplicated event wiring left.

Because the view-model is shared, promoting Blits to the default renderer is a
view-layer decision only: it needs GPU verification on the weakest target panel
(Group C in `HANDOFF.md`), not another integration.
