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

## On the device (Tizen / AOSP)

The device entries (`apps/tizen-app/src/main.ts`, `apps/aosp-app/web/main.ts`)
already default to `http://127.0.0.1:8080/v1`. Override per install by setting
globals before the bundle loads:

```js
window.__AGENT_LLM_BASE_URL__ = "http://127.0.0.1:8080/v1";
window.__AGENT_LLM_MODEL__ = "local-tv-agent";
```

So the on-device path is: ship a small quantized model + a local
OpenAI-compatible server on the TV, point the agent at loopback, done. Tool
calling must be supported by the model/server for TV control to work
(llama.cpp/Ollama/vLLM all support it for capable models).

## Choosing a model for TV-class hardware

- **RAM is the constraint.** Start with 1–3B parameter models, 4-bit quantized
  (Q4). A 3B Q4 model needs roughly ~2–3 GB RAM; verify headroom on the weakest
  target SoC before committing.
- **Tool calling matters more than raw quality** here — the agent needs reliable
  function-calling, not long-form prose. Prefer instruction-tuned models with
  good function-calling support.
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
