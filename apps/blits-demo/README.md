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
- The Blits component subscribes to `agent.events` (`token`, `tool:call`,
  `turn:end`) and updates reactive state — mirror of `mountAgentOverlay` /
  `mountAgentCanvas`.

To promote this into `packages/ui` as the default renderer later, keep the event
wiring and replace the DOM/2D-canvas draw calls with Blits components.
