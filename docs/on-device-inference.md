# On-device (and local) inference

The agent talks to any **OpenAI-compatible** `/chat/completions` endpoint via
`@tv-ai-agent/llm-connectors`. That means the *same* build runs against a cloud
gateway or a model running on `localhost` — including on the TV's own SoC. No
code change is needed; only the base URL differs.

```
Agent ──▶ createOpenAiCompatibleClient({ baseUrl }) ──▶ /chat/completions (SSE)
                                                         ├─ cloud gateway, or
                                                         └─ localhost model
```

## Try it locally in 2 minutes (dev harness)

Any of these servers expose the OpenAI schema. Start one, then open the dev
harness pointing at it — no rebuild:

### Ollama
```bash
ollama serve
ollama pull llama3.2:3b        # small, good starting point
# harness:  http://localhost:5173/?llm=http://127.0.0.1:11434/v1&model=llama3.2:3b
```

### llama.cpp (llama-server)
```bash
llama-server -m ./model.gguf --port 8080   # serves an OpenAI-compatible API
# harness:  http://localhost:5173/?llm=http://127.0.0.1:8080/v1&model=local
```

### vLLM
```bash
vllm serve <model> --port 8000
# harness:  http://localhost:5173/?llm=http://127.0.0.1:8000/v1&model=<model>
```

Run `pnpm dev` first to serve the harness at `http://localhost:5173`. Without a
`?llm=` the harness uses the built-in offline scripted brain.

## On the device (Tizen / AOSP / webOS)

All three device entries default to `http://127.0.0.1:8080/v1`, and every one of
them accepts a **query override** so a *packaged, signed* app can be repointed
without a rebuild — that is `resolveLlmEndpoint()`, shared with the harness:

```bash
# AOSP: note the escaped & (the device shell would background the command)
adb shell am start -n tv.aiagent.harness/.MainActivity \
  -e start 'index.html?llm=http://127.0.0.1:8080/v1\&model=qwen2.5'
```

Precedence is `?llm=`/`?model=`/`?key=` → window globals → the built-in default:

```js
window.__AGENT_LLM_BASE_URL__ = "http://127.0.0.1:8080/v1";
window.__AGENT_LLM_MODEL__ = "local-tv-agent";
```

**Reaching a server on your workstation** (rather than on the TV): use
`adb reverse tcp:8080 tcp:<your port>` so the device talks to its own loopback.
That keeps it inside both the app's CSP and the Android cleartext policy, which
permits plain http for loopback only — a LAN address would be blocked by design.

So the on-device path is: ship a small quantized model + a local
OpenAI-compatible server on the TV, point the agent at loopback, done. Tool
calling must be supported by the model/server for TV control to work
(llama.cpp/Ollama/vLLM all support it for capable models).

## Measured: 1.5B on the Android TV emulator (2026-07-30)

First run of the acceptance script driven by a **real** model instead of the
scripted brain — Qwen2.5-1.5B-Instruct Q4_K_M under `llama-server --jinja`, host
CPU (8 threads), reached from the emulator via `adb reverse`.

**The platform path works end to end.** The model emitted OpenAI tool calls, the
WebView executed them through the Kotlin bridge, and `AudioManager` state actually
changed: `set_volume`, `set_volume`, `set_mute` all fired and the TV ended muted.

**The model is the weak link, not the device.** Against the same script the
scripted brain reproduces the CI sequence exactly; the 1.5B model did not:

| Command | What a capable model does | What 1.5B did |
|---|---|---|
| "make it louder" | `get_volume` → `set_volume(+10)` | `set_volume(33)` directly, and claimed "already at maximum" |
| "open YouTube" | `search_app_by_name` → `launch_app` | refused and asked the user for an app id |
| "what's the volume?" | `get_volume` | answered "33" from context — while the TV was actually muted (0) |
| "音量調到 30" | replies in Traditional Chinese | replied in Simplified |

So: **multi-step tool chaining is the capability that decides the model floor**,
not prose quality. 1.5B is below it. Test 3B and 7B-class quantized models before
picking a target, and treat "same tool sequence as `packages/acceptance`" as the
bar (`tools/device-acceptance.mjs` prints which of the two is at fault).

Throughput for reference — host CPU, *not* TV silicon, so read it as an upper
bound: ~54-69 tok/s prefill, ~8-14 tok/s generation, with 215-251-token prompts
(the tool schemas dominate). Each command costs 1-3 of those round trips.

## Choosing a model for TV-class hardware

- **RAM is the constraint.** Start with 1–3B parameter models, 4-bit quantized
  (Q4). A 3B Q4 model needs roughly ~2–3 GB RAM; verify headroom on the weakest
  target SoC before committing.
- **Tool *chaining* matters more than raw quality** here — the agent needs
  reliable function-calling *across turns* (read-then-write, search-then-launch),
  not long-form prose. The measurement above shows a 1.5B model calling single
  tools fine and failing every chained one.
- **Latency budget:** the agent loop makes 1–3 calls per command. Benchmark
  end-to-end on the target board (Phase 4) and keep prompts small — the runtime
  already trims history aggressively (`ConversationContext`).
- **NPU/accelerator:** where the SoC exposes an NPU runtime with an
  OpenAI-compatible shim, point the base URL at it — the agent is unchanged.

## Privacy

Running on loopback keeps commands on-device — nothing leaves the TV. If you
route to a cloud endpoint for harder requests, document what is sent and prefer
keeping sensitive actions (anything controlling the device) on the local model.
This cloud/on-device routing policy is a Phase 4 deliverable.
