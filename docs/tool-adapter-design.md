# Tool and Adapter Design

> The agent core must never contain the strings `adb shell`, `tizen.`, `luna://`,
> a Titan endpoint or a Xumo command. Not once. That rule is the architecture.

## Three layers, one direction

```
Agent Core   world - capabilities - devices - planner - policy - verification
    |  invokes a capability id with validated args
    v
Tool Layer   discover - canExecute - execute - verify - rollback
    |  calls a HAL interface
    v
Adapter      aosp | titan | xumo | webos | tizen | roku | linux | mock
```

Nothing points upward. An adapter cannot see the planner; a tool cannot see the
world model except through the context handed to it.

## Tool interface

Today a `Tool` is `{ spec, execute }`. That is enough for command mapping and not
enough for planning. The target:

```ts
interface Tool<Args, Result> {
  spec: ToolSpec;                 // unchanged — what the LLM sees
  capability?: string;            // the Capability id this tool implements

  discover?(): Promise<boolean>;  // is this usable on this device, right now?
  canExecute?(args: Args, ctx: ToolContext): Promise<CanExecute>;  // preconditions, cheap
  execute(args: Args, ctx?: ToolContext): Promise<Result>;
  verify?(args: Args, ctx: ToolContext): Promise<VerifyOutcome>;
  rollback?(args: Args, ctx: ToolContext): Promise<void>;
}
```

All four new members are **optional**, which is what makes this additive: today's
fifteen tools keep working untouched, and the executor falls back to
`{ kind: "none" }` verification with a recorded reason.

`rollback` is for compound plans: if `movie_night` dims the lights and then fails
to switch input, the lights should come back up. Only capabilities that are
genuinely reversible implement it; the rest declare that they are not, and the
planner refuses to include an irreversible step in a plan it cannot complete.

## Tool taxonomy

```
tools/
|- tv/          volume, mute, input, picture mode, power        (via HAL)
|- hdmi_cec/    device power, active source, OSD name           (P1)
|- ir/          blaster profiles for devices with no back channel(P1)
|- audio/       output route, audio profile, AVR control        (P1)
|- camera/      occupancy, presence — emits perception events   (P2)
|- microphone/  wake word, ambient noise                        (P1/P2)
|- network/     reachability, wake-on-LAN                       (P1)
|- content/     search, recommend, availability, play, metadata (provider-backed)
`- iot/         lights, AC, blinds via Matter / Home Assistant  (P2)
```

## Content is a provider, never the core

Titan OS and Xumo already do content discovery, universal search and
recommendation well. We do not rebuild any of it. A content source implements one
interface and registers as a tool provider:

```ts
interface ContentProvider {
  id: string;                                     // "xumo" | "titan" | "youtube" | "epg"
  search(query: string, opts?): Promise<ContentItem[]>;
  recommend(context: RecommendContext): Promise<ContentItem[]>;
  availability(item: ContentRef): Promise<Availability[]>;
  play(item: ContentRef): Promise<PlaybackHandle>;
  getMetadata(item: ContentRef): Promise<ContentMetadata>;
}
```

Rules:

1. The World Model and the planner reference **`ContentRef`**, never a
   provider-specific id.
2. Multiple providers coexist and are ranked (entitlement, price, quality,
   the user's habits) — ranking is ours; the catalogue is theirs.
3. A missing provider degrades the plan, never breaks the core.
4. `packages/skill-manifest` already provides the declarative, sandboxed way to
   add an HTTP-backed provider without shipping code. Use it first.

## OS adapter layer

```
adapters/os/
|- android_tv/   implemented   (packages/adapter-aosp)
|- webos/        implemented   (packages/adapter-webos)
|- tizen/        implemented   (packages/adapter-tizen)
|- linux/        implemented   (packages/adapter-linux)
|- mock/         implemented   (packages/adapter-web)
|- titan_os/     stub + contract test only            (P3)
|- xumo/         stub + contract test only            (P3)
`- roku/         stub + contract test only            (P3)
```

The interface every adapter satisfies, stated in the vocabulary of the new
architecture:

```ts
interface TvOsAdapter {
  discoverCapabilities(): Promise<Capability[]>;   // what this OS grants, here, today
  getState(): Promise<Partial<LivingRoomState>>;   // what it can observe
  executeAction(action: Action): Promise<TvResult>;
  verifyAction(action: Action): Promise<VerifyOutcome>;
}
```

This does **not** replace `PlatformProvider`. `PlatformProvider` stays as the
capability-implementation surface — it is proven, contract-tested and running on
five targets. `TvOsAdapter` is the thin façade the core talks to, and the default
implementation derives it from any `PlatformProvider`:

```ts
const adapter = createAdapterFromPlatform(platformProvider);
```

An OS whose control surface does not fit the TV-shaped HAL (a REST-controlled
Titan device, a Roku ECP endpoint) implements `TvOsAdapter` directly and skips
the HAL. That is the escape hatch that keeps us from bending the HAL out of shape
for every new platform.

### The test of the boundary

Adding Titan OS or Xumo must change **only** files under `packages/adapter-*`
plus one registration line in a host. It must not change:

```
planner  world model  capability graph  device graph  policy  memory  agent core
```

Enforced three ways:

1. An ESLint `no-restricted-imports` rule: core modules may not import
   `@tv-ai-agent/adapter-*`.
2. `assertProviderContract` — every adapter passes the same behavioural spec.
3. `packages/acceptance` — the same command script must produce the same tool
   sequence and end state on every target.

All three exist today. They are the reason this repositioning is a refactor and
not a rewrite.

## Naming

- Capability ids: `<device>.<domain>.<verb>` — `tv.audio.set_volume`,
  `ps5.power.on`.
- Tool names stay `snake_case` (the LLM-facing surface, unchanged).
- Adapter packages: `@tv-ai-agent/adapter-<os>`.
