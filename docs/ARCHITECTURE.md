# Architecture

## Layers

1. **Core (`packages/core`) — the Harness.** Platform-agnostic. The agent loop
   sends the conversation + tool specs to an `LlmClient`, executes any requested
   tool calls, feeds results back, and repeats until a final answer (bounded by
   `maxIterations`). Also owns the tool registry, rolling memory/context and a
   typed event bus for observability. Depends only on `platform-api` types.

2. **Platform HAL (`packages/platform-api`).** Stable capability interfaces:
   `SystemControl`, `AppControl`, `Navigation`, `NetworkInfo`, `KeyValueStore`,
   and optional `MediaControl` / `VoicePipeline`. The core talks only to these.

3. **Adapters (`packages/adapter-*`).** Concrete HAL implementations:
   - `adapter-tizen` → `tizen.*` / `webapis.*` Device APIs.
   - `adapter-aosp` → injected `TvNativeBridge` (Kotlin, `addJavascriptInterface`).
   - `adapter-web` → in-memory mock for dev/CI and the reference implementation.

4. **LLM connectors (`packages/llm-connectors`).** `LlmClient` implementations.
   `createOpenAiCompatibleClient` works with hosted APIs *and* local servers
   (llama.cpp / Ollama / vLLM), so inference location is a config value.

5. **App hosts (`apps/*`).** Package the web bundle for a device: Tizen `.wgt`
   and an AOSP `WebView` activity that installs the native bridge.

## Request flow

```
user text ─▶ Agent.run()
             │  add to context
             ▼
        LlmClient.complete(messages, tools)
             │
    wantsToolCalls? ── no ─▶ return final answer
             │ yes
             ▼
     ToolRegistry.call(name, args)  ──▶ PlatformProvider (HAL) ──▶ OS/SoC
             │  result
             ▼
     append tool result to context ─▶ (loop)
```

## Why the HAL boundary matters

Every OS/SoC difference is absorbed by an adapter. Adding webOS later, or
supporting a new vendor control, never touches the core or the tools — you
implement the interface and add a contract test. This is what makes "write once,
run on MTK + NVT, AOSP + Tizen" real rather than aspirational.

## Capability degradation

Firmware varies in what it exposes. Optional HAL members plus
`PlatformProvider.has(...)` let the agent discover, at runtime, what a given
device supports and avoid advertising tools it can't fulfil.
