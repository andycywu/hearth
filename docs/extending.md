# Extending the agent

Two common extensions need **no core changes**: adding your own tools, and
persisting conversations.

> Writing a whole feature rather than a single tool? [`skills.md`](skills.md)
> covers what makes a skill portable across every TV target, with a runnable
> example (`packages/skills-example`).

## Custom tools

Pass extra tools when constructing the `Agent`. They are registered alongside the
built-in TV tools and become available to the model immediately. Use `defineTool`
for inferred argument types.

```ts
import { Agent, defineTool } from "@tv-ai-agent/core";

const openSettings = defineTool(
  {
    name: "open_settings",
    description: "Open a settings page by section.",
    parameters: {
      section: { type: "string", description: "e.g. network, picture", required: true },
    },
  },
  async (args) => {
    // ...call your app/platform API...
    return { ok: true, section: args.section };
  },
);

const agent = new Agent({ platform, llm, tools: [openSettings] });
```

Rules:
- The `parameters` schema is enforced (`validateArgs`) before your `execute`
  runs — required fields, type coercion and `enum` checks. You receive clean args.
- Return JSON-serializable values; the result is fed back to the model.
- Throwing is fine — the error is returned to the model as a structured result so
  it can recover, rather than aborting the turn.
- There is a built-in `help` tool that lists all registered tools, so users can
  ask "what can you do?".

## Persisting conversations

Set `persistKey` to auto-save history to `platform.storage` after every turn, and
call `restore()` once at startup to reload it (e.g. so a session survives an app
reload).

```ts
const agent = new Agent({ platform, llm, persistKey: "session:main" });
await agent.restore();     // reload prior history if any
await agent.run("hi again");
agent.reset();             // clears history AND the persisted copy
```

Persistence is best-effort: a storage failure never fails a turn. History is
trimmed to the same rolling cap as in-memory context.

## Confirmation for high-impact tools

Mark a tool with `confirm: true` and pass an `Agent` `confirm` handler; the agent
asks before running it. Declining feeds a structured result back to the model so
it can adapt instead of aborting. Built-in `set_input_source` and `launch_app`
are already flagged.

```ts
const agent = new Agent({
  platform, llm,
  confirm: async (req) => window.confirm(`Allow ${req.name}?`),
});

const restart = defineTool(
  { name: "factory_reset", description: "Wipe the TV", confirm: true, parameters: {} },
  async () => { /* ... */ return { ok: true }; },
);
```

When no `confirm` handler is set, confirm-required tools run without prompting —
so opt in to the guard in production builds.

## Skills vs. new device capabilities

A tool that needs only `fetch` or arithmetic is a **skill** — portable to every
target as-is. A tool that needs a privileged platform API is a **HAL change**:
extend `platform-api`, implement it in every adapter, add it to
`assertProviderContract`, then expose the tool. [`skills.md`](skills.md) explains
the split and why it decides whether you need a vendor signature.

## New OS target

Add `packages/adapter-<os>` implementing `PlatformProvider`, add a contract test
(`assertProviderContract`), and an app host under `apps/`. The core, tools and UI
are untouched. See the tizen/aosp/webos adapters as references.
