# A2 — Shared view-model; make Blits a first-class renderer

## Why
Three renderers (`mountAgentOverlay` DOM, `mountAgentCanvas` 2D, the Blits WebGL
`apps/blits-demo`) each duplicate the same agent-event → view-state wiring.
Extract that wiring into one tested, framework-agnostic **view-model** in
`packages/ui`, then have all three consume it. This "promotes" Blits to a
first-class citizen without pulling Vite/Blits into the main workspace/CI.

## Design
`packages/ui/src/view-model.ts` exports `createAgentViewModel(agent)`:
- Holds reactive-ish state: `{ reply: string; activity: string; error: string }`.
- Subscribes to `agent.events` (`turn:start`, `token`, `tool:call`, `turn:end`,
  `error`) and mutates state.
- Exposes `subscribe(cb)` (called on every change) and `snapshot()`.
- `destroy()` unsubscribes.
This is pure (no DOM) → unit-testable with a fake Agent/EventBus.

## Files
- **New:** `packages/ui/src/view-model.ts`, `packages/ui/src/view-model.test.ts`
- **Edit:** `packages/ui/src/overlay.ts`, `packages/ui/src/canvas.ts` to use the
  view-model instead of inline subscriptions.
- **Edit:** `packages/ui/src/index.ts` to export it.
- **Edit:** `apps/blits-demo/src/index.js` to import `createAgentViewModel` (via
  the alias to `@hearthkit/ui` — add it to `vite.config.js` `resolve.alias`
  pointing at `packages/ui/dist/index.js`).

## Steps
1. Implement `createAgentViewModel`:
   ```ts
   import type { Agent } from "@hearthkit/core";
   import { formatToolCall, truncate } from "./format.js";

   export interface AgentViewState { reply: string; activity: string; error: string }
   export interface AgentViewModel {
     snapshot(): AgentViewState;
     subscribe(cb: (s: AgentViewState) => void): () => void;
     destroy(): void;
   }

   export function createAgentViewModel(agent: Agent): AgentViewModel {
     const state: AgentViewState = { reply: "", activity: "", error: "" };
     const subs = new Set<(s: AgentViewState) => void>();
     const emit = () => subs.forEach((cb) => cb({ ...state }));
     const off = [
       agent.events.on("turn:start", () => { state.reply = ""; state.activity = ""; state.error = ""; emit(); }),
       agent.events.on("token", ({ delta }) => { state.reply += delta; emit(); }),
       agent.events.on("tool:call", ({ name, args }) => { state.activity = truncate(formatToolCall(name, args)); emit(); }),
       agent.events.on("turn:end", ({ output }) => { if (!state.reply) state.reply = output; state.activity = ""; emit(); }),
       agent.events.on("error", ({ error }) => { state.error = error.message; emit(); }),
     ];
     return {
       snapshot: () => ({ ...state }),
       subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
       destroy: () => { off.forEach((u) => u()); subs.clear(); },
     };
   }
   ```
2. Refactor `overlay.ts` and `canvas.ts`: replace their inline `agent.events.on(...)`
   blocks with `const vm = createAgentViewModel(agent); vm.subscribe((s) => render(s));`
   and move drawing into a `render(state)` function. Keep the exact same visual
   behaviour and the public `mountAgentOverlay` / `mountAgentCanvas` signatures.
3. Export from `index.ts`:
   ```ts
   export { createAgentViewModel, type AgentViewModel, type AgentViewState } from "./view-model.js";
   ```
4. Update `apps/blits-demo`:
   - `vite.config.js`: add `"@hearthkit/ui": pkg("ui")` to `resolve.alias`.
   - `src/index.js`: build the agent, then
     `const vm = createAgentViewModel(agent); vm.subscribe(s => { this.reply = s.reply; this.activity = s.activity; });`
     inside the Blits component `ready()` hook (replaces the manual event subs).
5. Add `view-model.test.ts`: drive a fake Agent (reuse the pattern in
   `packages/core/src/agent/agent.test.ts`) or a minimal object with an
   `EventBus`, emit events, assert `snapshot()` transitions and that `subscribe`
   fires. Aim for: token accumulation, activity set on tool:call, reply fallback
   on turn:end, error captured.

## Acceptance
- `packages/ui` builds; new tests green; `mountAgentOverlay`/`mountAgentCanvas`
  behave exactly as before (dev harness `?render=canvas` still works).
- `apps/blits-demo` builds (`cd apps/blits-demo && npm install && npm run build`)
  using the shared view-model.
- Main green gate passes. Blits stays out of the pnpm workspace/CI.

## Verify
```bash
pnpm build && pnpm test           # ui tests incl. view-model
pnpm bundle:dev                    # dev harness still bundles
cd apps/blits-demo && npm install && npm run build   # WebGL demo still builds
```

## Notes
- Do **not** add `@lightningjs/blits` or `vite` to any `packages/*` — they must
  stay only in `apps/blits-demo`. The point is shared *logic*, not shared deps.
- Full WebGL rendering/perf verification is Group C (needs a browser).
