# A4 — Wire voice + confirm into device app entries

## Why
The dev harness (`apps/dev-harness/src/main.ts`) has: a `confirm` handler for
high-impact tools, voice (mic + wake word), and a transcript. The three device
entries don't. Bring them to parity so on-device behaviour matches the demo.

Entries to update:
- `apps/tizen-app/src/main.ts`
- `apps/aosp-app/web/main.ts`
- `apps/webos-app/src/main.ts`

## What to add to each entry (after creating the Agent)
1. **Confirm handler** (uses the platform if it has a native prompt; else a
   simple allow with a console log — device UIs vary, keep minimal):
   ```ts
   const agent = new Agent({
     platform, llm,
     confirm: async (req) => {
       // TODO: replace with a real on-screen confirm dialog per platform.
       console.info("[confirm]", req.name, req.args);
       return true;
     },
   });
   ```
2. **Speak replies when voice is available:**
   ```ts
   if (platform.has("voice") && platform.voice) {
     const voice = platform.voice;
     agent.events.on("turn:end", ({ output }) => { void voice.speak(output); });
   }
   ```
3. Keep the existing `?diag` handling and `__AGENT_LLM_BASE_URL__` defaults.

Optionally extract the shared boot logic into a tiny helper to avoid copy-paste:
`packages/ui` could export `createAgentForPlatform(platform, { llm, confirm })` —
but only if it stays platform-agnostic. If unsure, just duplicate the ~6 lines.

## Acceptance
- All three device bundles build unchanged in structure; `pnpm bundle:all` green.
- Grep confirms each entry now constructs the Agent with a `confirm` handler and
  a voice `speak` on `turn:end`.

## Verify
```bash
pnpm bundle:tizen && pnpm bundle:aosp && pnpm bundle:webos
grep -l "confirm:" apps/tizen-app/src/main.ts apps/aosp-app/web/main.ts apps/webos-app/src/main.ts
```

## Notes
- Real confirm UIs (a focusable on-screen dialog) are a later polish; the hook is
  what matters now so gated tools don't fire silently on device.
- Don't add DOM-only assumptions that break the (headless) bundling.
