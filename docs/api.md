# API Reference

Public API of the TV AI Agent packages. Types are TypeScript. This is a curated
reference; the source is the ground truth.

---

## `@tv-ai-agent/core`

The platform-agnostic agent runtime ("the Harness").

### `class Agent`

```ts
new Agent(options: AgentOptions)
```

| Member | Signature | Description |
|--------|-----------|-------------|
| `run` | `run(input: string, opts?: { signal?: AbortSignal }): Promise<string>` | Runs one turn: LLM → tool calls → final answer. Bounded by `maxIterations` and `turnTimeoutMs`. |
| `restore` | `restore(): Promise<boolean>` | Reloads persisted history (needs `persistKey`). Returns true if restored. |
| `reset` | `reset(): void` | Clears history (and the persisted copy). |
| `historyLength` | `get: number` | Retained message count (excludes system prompt). |
| `toolRegistry` | `get: ToolRegistry` | The live registry (inspect / add tools). |
| `events` | `EventBus<AgentEvents>` | Observe the turn lifecycle. |
| `world` | `WorldModel` | What the agent knows about the room. Tool results land here automatically; see [world-model.md](world-model.md). |
| `pursue` | `pursue(goal: Goal, opts?): Promise<PlanOutcome>` | The goal path: plan → policy → execute → verify. See [agent-planner.md](agent-planner.md). |
| `pursueSkill` | `pursueSkill(skill: Skill \| string, params?, opts?): Promise<PlanOutcome>` | Same, for a named scenario; resolves its parameters against the room first. |
| `observe` | `observe(capabilityId: string): Promise<void>` | Run one read capability and fold the answer into `world`. |
| `describe` | `describe(outcome: PlanOutcome): string` | What a plan amounted to, in a sentence. Never reports `unverified` as done. |
| `capabilities` | `CapabilityGraph` | What this device can do, and what was withdrawn. |
| `devices` | `DeviceGraph` | What is in the room. Empty until a host runs discovery. |
| `policy` | `PolicyEngine` | Consulted before every plan step. |

```ts
interface AgentOptions {
  platform: PlatformProvider;
  llm: LlmClient;
  systemPrompt?: string;
  maxIterations?: number;   // default 6
  turnTimeoutMs?: number;   // default 30_000
  tools?: Tool[];           // extra/custom tools
  persistKey?: string;      // auto-save history to platform.storage
  confirm?: (req: ConfirmRequest) => boolean | Promise<boolean>;
  unattended?: boolean;     // no human present: policy's `ask` becomes `allow`
  world?: WorldModel;       // share one with a planner; otherwise the agent owns it
  devices?: DeviceGraph;    // what discovery found; otherwise empty
  policy?: PolicyEngine;    // defaults to the built-in risk rules
  worldInPrompt?: boolean;  // put known facts in the system prompt (default true)
  worldPromptChars?: number;// budget for that block (default 400)
}

interface ConfirmRequest { name: string; args: Record<string, unknown>; description: string }
```

### Events — `AgentEvents`

```ts
"turn:start"  { input: string }
"token"       { delta: string }        // streaming text
"tool:call"   { name: string; args: unknown }
"tool:result" { name: string; result: unknown }
"turn:end"    { output: string }
"plan:start"  { plan: Plan }              // the goal path
"plan:step"   { outcome: StepOutcome }    // after each step, with its status
"plan:end"    { outcome: PlanOutcome }
"policy:decision" { entry: PolicyAuditEntry }   // from either path
"error"       { error: Error }
```

`agent.events.on(event, cb)` returns an unsubscribe function.

### Tools

```ts
interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  confirm?: boolean;   // gate behind AgentOptions.confirm
}
interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
}
interface Tool<A = Record<string, unknown>, R = unknown> {
  spec: ToolSpec;
  execute(args: A): Promise<R>;
}

function defineTool<A, R>(spec: ToolSpec, execute: (args: A) => Promise<R>): Tool<A, R>;
function validateArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown>;
createTvTools(platform: PlatformProvider): Tool[];   // built-in TV tools
```

`class ToolRegistry` — `register(tool)`, `has(name)`, `getSpec(name)`, `list()`,
`call(name, args)` (validates then executes).

Errors: `ToolValidationError`, `UnknownToolError`, `TurnTimeoutError`.

### Diagnostics

```ts
runDiagnostics(platform: PlatformProvider, opts?: { allowWrites?: boolean }): Promise<DiagnosticsReport>;
reportToMarkdown(report: DiagnosticsReport): string;
```

### LLM client interface

```ts
interface LlmClient {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  completeStream?(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult>;
}
interface StreamHandlers { onContentDelta?(delta: string): void }
```

Also exported: `ConversationContext`, `EventBus`, and the message types
`ChatMessage`, `ToolCall`, `CompletionRequest`, `CompletionResult`.

---

## `@tv-ai-agent/platform-api`

The Platform Abstraction Layer (HAL). Adapters implement `PlatformProvider`.

```ts
interface PlatformProvider {
  readonly device: DeviceInfo;
  readonly system: SystemControl;
  readonly apps: AppControl;
  readonly navigation: Navigation;
  readonly network: NetworkInfo;
  readonly storage: KeyValueStore;
  readonly media?: MediaControl;
  readonly voice?: VoicePipeline;
  has(capability: keyof PlatformProvider): boolean;
  init(): Promise<void>;
}

interface DeviceInfo { os: "aosp"|"tizen"|"webos"|"web"; osVersion: string; soc: string; model: string; capabilities: Record<string, boolean> }

interface SystemControl {
  getVolume(): Promise<number>; setVolume(level: number): Promise<void>;
  getMute(): Promise<boolean>;  setMute(mute: boolean): Promise<void>;
  getInputSource(): Promise<InputSource>; setInputSource(source: InputSource): Promise<void>;
  powerStandby(): Promise<void>;
}
interface AppControl {
  listInstalledApps(): Promise<AppEntry[]>;
  launchApp(appId: string, params?: Record<string, string>): Promise<void>;
  getForegroundApp(): Promise<AppEntry | null>;
  findAppsByName(query: string): Promise<AppEntry[]>;
}
interface Navigation {
  sendKey(key: RemoteKey): Promise<void>;
  isAvailable?(): Promise<boolean>;
  requestSetup?(): Promise<void>;
}
interface MediaControl { play(uri): Promise<void>; pause(): Promise<void>; resume(): Promise<void>; seek(ms): Promise<void> }
interface NetworkInfo { isOnline(): Promise<boolean>; connectionType(): Promise<"wifi"|"ethernet"|"none"> }
interface KeyValueStore { get(k): Promise<string|null>; set(k, v): Promise<void>; delete(k): Promise<void> }
interface VoicePipeline {
  startListening(): Promise<void>; stopListening(): Promise<void>;
  onTranscript(cb: (text: string, isFinal: boolean) => void): () => void;
  speak(text: string): Promise<void>;
  startWakeWord?(phrase: string, onWake: () => void): Promise<void>;
  stopWakeWord?(): Promise<void>;
}
```

Helpers: `matchAppsByName(apps, query)`, `assertProviderContract(factory, opts?)`.
Types: `InputSource`, `RemoteKey`, `AppEntry`.

---

## `@tv-ai-agent/llm-connectors`

```ts
createOpenAiCompatibleClient(opts: {
  baseUrl: string; model: string; apiKey?: string; fetchImpl?: typeof fetch;
}): LlmClient;

createScriptedClient(opts?: { id?: string }): LlmClient;   // offline rule-based brain

class StreamAccumulator   // OpenAI SSE delta accumulator (for tests/tools)
```

`createOpenAiCompatibleClient` works with any OpenAI-compatible endpoint (cloud or
localhost llama.cpp / Ollama / vLLM) and supports streaming.

---

## `@tv-ai-agent/ui`

```ts
mountAgentOverlay(agent: Agent, opts?: { mount?: HTMLElement; showActivity?: boolean }): OverlayController;
// OverlayController: { ask(input: string): Promise<void>; destroy(): void }
mountAgentCanvas(agent: Agent, opts?: { mount?: HTMLElement; width?: number; height?: number }): CanvasController;

// Shared, DOM-free wiring every renderer consumes.
createAgentViewModel(agent: Agent): AgentViewModel;
// AgentViewModel: { snapshot(): AgentViewState; subscribe(cb): () => void; destroy(): void }
// AgentViewState: { reply, activity, error: string; busy, streamed: boolean }

// Device-host helpers.
createConfirmHandler(opts?: { ask?: (q: string) => boolean | Promise<boolean>; fallback?: boolean }):
  (req: ConfirmRequest) => boolean | Promise<boolean>;
speakReplies(agent: Agent, platform: PlatformProvider): () => void;

formatToolCall(name: string, args: unknown): string;
truncate(text: string, max?: number): string;
wrapLines(measure: (s: string) => number, text: string, maxWidth: number): string[];
```

`createAgentViewModel` is the whole renderer contract: the DOM overlay, the 2D
canvas and the Blits WebGL demo differ only in how they draw its state. State is
undecorated — prefixes and truncation belong to the renderer. See
`packages/ui/README.md`.

---

## `@tv-ai-agent/skills-example`

```ts
createWeatherTool(opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; language?: string }):
  Tool<{ city: string }, { city: string; country?: string; tempC: number; summary: string }>;
```

A worked, keyless example of a portable skill — see [`skills.md`](skills.md).

---

## Adapters

Each exports a factory returning a `PlatformProvider`:

```ts
createWebAdapter()    // @tv-ai-agent/adapter-web   — in-memory mock (+ Web Speech voice)
createTizenAdapter()  // @tv-ai-agent/adapter-tizen — tizen.* / webapis.*
createAospAdapter()   // @tv-ai-agent/adapter-aosp  — WebView TvNativeBridge
createWebosAdapter()  // @tv-ai-agent/adapter-webos — Luna Service Bus
```

See [`docs/extending.md`](extending.md) for adding tools, persistence and new OS
targets.
