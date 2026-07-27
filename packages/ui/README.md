# @tv-ai-agent/ui

A minimal, **dependency-free** 10-foot UI shell for the agent. `mountAgentOverlay`
attaches a DOM overlay that subscribes to the agent's event bus and renders
status, streamed tokens and tool activity.

```ts
import { Agent } from "@tv-ai-agent/core";
import { mountAgentOverlay } from "@tv-ai-agent/ui";

const ui = mountAgentOverlay(agent);   // agent: an @tv-ai-agent/core Agent
await ui.ask("turn the volume down");  // streams the reply into the overlay
```

## Why start with DOM
Zero dependencies, works in every TV WebView/Tizen engine today, and it exercises
the streaming (`token`) and tool events end-to-end. Event wiring is isolated from
rendering so the view layer can be swapped without touching agent logic.

## Lightning 3 / Blits upgrade path (low-end MTK/NVT)
On very low-end GPUs a DOM-heavy UI can drop frames. To switch to a WebGL
renderer, keep the same event subscriptions from `overlay.ts` and render into a
Lightning/Blits canvas instead of DOM nodes:

```bash
pnpm --filter @tv-ai-agent/ui add @lightningjs/blits
```

Then implement a `mountAgentOverlayBlits(agent)` that mirrors the `render*`
wiring. The `Agent` + event contract is unchanged — this is purely a view swap.
See `docs/DEVELOPMENT_PLAN.md` (Phase 3).
