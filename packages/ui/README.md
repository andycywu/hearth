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

## The shared view-model — write a renderer in ~20 lines
Every renderer here consumes one piece of tested, DOM-free logic:

```ts
import { createAgentViewModel } from "@tv-ai-agent/ui";

const vm = createAgentViewModel(agent);
vm.subscribe((s) => draw(s));   // { reply, activity, error, busy, streamed }
vm.destroy();                   // detach
```

`createAgentViewModel` owns the agent-event subscriptions (`turn:start`, `token`,
`tool:call`, `turn:end`, `error`) and reduces them to a small state object.
Values are **undecorated** — prefixes (`· `, `⚠ `) and truncation belong to the
renderer, since a DOM overlay, a canvas and a WebGL scene each have different
room. `streamed` tells you whether `reply` came from the token stream or from the
final output, so a renderer can cap a long non-streamed answer without clipping
live text.

That is the whole contract a new view layer has to satisfy: all three renderers
in this repo (DOM overlay, 2D canvas, Blits WebGL) differ only in `draw`.

## Device-host helpers (confirm + spoken replies)
The two things every host needs beyond drawing, so the Tizen / AOSP / webOS
entries don't each grow their own copy:

```ts
import { createConfirmHandler, speakReplies } from "@tv-ai-agent/ui";

const agent = new Agent({ platform, llm, confirm: createConfirmHandler() });
speakReplies(agent, platform);   // no-op unless platform.has("voice")
```

`createConfirmHandler()` gates the tools whose spec sets `confirm: true`
(`set_input_source`, `launch_app`). It asks via `window.confirm` by default; pass
`ask` to swap in a focusable 10-foot dialog, and `fallback: false` to deny
instead of approve on engines that provide no dialog at all. Without a handler,
`Agent` runs confirm-required tools unprompted.

`speakReplies` speaks each turn's final output and returns an unsubscribe. TTS
failures are swallowed — speech must never break a turn.

## Single-surface canvas renderer
`mountAgentCanvas(agent)` draws everything onto one `<canvas>` (2D context) from
the **same view-model** — no DOM reflow, which is the pattern that keeps a
10-foot UI smooth on low-end GPUs. Try it in the dev harness with
`?render=canvas`. The pure `wrapLines(measure, text, maxWidth)` helper handles
Latin and CJK wrapping and is unit-tested. This is the stepping stone to the WebGL
path below.

## Lightning 3 / Blits renderer (low-end MTK/NVT)
On very low-end GPUs a DOM-heavy UI can drop frames, so the WebGL renderer lives
in `apps/blits-demo` and consumes `createAgentViewModel` from this package —
`apps/blits-demo/src/index.js` maps the state onto Blits reactive properties and
that is all the integration there is.

It stays a separate app **on purpose**: `@lightningjs/blits` and Vite must not
become dependencies of `packages/*` (this package remains dependency-free and
buildable with plain `tsc`), so the demo has its own `node_modules` and is
outside the pnpm workspace and CI. Shared *logic*, not shared deps.

```bash
pnpm build                                  # produces the dist/ the demo aliases
cd apps/blits-demo && npm install && npm run dev
```

Making Blits the default renderer with a DOM fallback is Group C in
`HANDOFF.md` — it needs GPU verification on the weakest target panel first. See
also `docs/DEVELOPMENT_PLAN.md` (Phase 3).
