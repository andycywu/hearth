import type {
  LlmClient, CompletionRequest, CompletionResult, ChatMessage, ToolCall, StreamHandlers,
} from "@tv-ai-agent/core";

export interface OpenAiCompatibleOptions {
  /** Base URL of an OpenAI-compatible /chat/completions endpoint. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
}

/**
 * Works with any OpenAI-compatible server: hosted APIs, or a local runtime such
 * as llama.cpp / Ollama / vLLM exposing the same schema. This is the seam that
 * lets the TV run fully on-device (point baseUrl at localhost) or in the cloud.
 */
export function createOpenAiCompatibleClient(opts: OpenAiCompatibleOptions): LlmClient {
  const doFetch = opts.fetchImpl ?? fetch;

  function url(): string {
    return `${opts.baseUrl}/chat/completions`;
  }
  function headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    };
  }
  function buildBody(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    return {
      model: opts.model,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 512,
      stream,
      messages: req.messages.map(toApiMessage),
      tools: req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: "object",
            properties: t.parameters,
            required: Object.entries(t.parameters).filter(([, p]) => p.required).map(([k]) => k),
          },
        },
      })),
      tool_choice: "auto",
    };
  }

  return {
    id: `openai:${opts.model}`,

    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const res = await doFetch(url(), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(buildBody(req, false)),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
      const json: any = await res.json();
      const choice = json.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] | undefined = choice.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        args: safeParse(tc.function.arguments),
      }));
      const message: ChatMessage = { role: "assistant", content: choice.content ?? "", toolCalls };
      return { message, wantsToolCalls: !!toolCalls && toolCalls.length > 0 };
    },

    async completeStream(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult> {
      const res = await doFetch(url(), {
        method: "POST",
        headers: { ...headers(), accept: "text/event-stream" },
        body: JSON.stringify(buildBody(req, true)),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
      if (!res.body) throw new Error("LLM stream response has no body");

      const acc = new StreamAccumulator(handlers);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          acc.pushEvent(rawEvent);
        }
      }
      if (buffer.trim()) acc.pushEvent(buffer);
      return acc.result();
    },
  };
}

/**
 * Accumulates OpenAI-style streaming deltas into a final CompletionResult.
 * Exported so the SSE handling can be unit-tested without a live server.
 */
export class StreamAccumulator {
  private content = "";
  private toolCalls = new Map<number, { id: string; name: string; args: string }>();

  constructor(private readonly handlers: StreamHandlers = {}) {}

  /** Feed one raw SSE event (may contain multiple `data:` lines). */
  pushEvent(rawEvent: string): void {
    for (const line of rawEvent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let json: any;
      try { json = JSON.parse(payload); } catch { continue; }
      const delta = json.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.content += delta.content;
        this.handlers.onContentDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = this.toolCalls.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        this.toolCalls.set(i, cur);
      }
    }
  }

  result(): CompletionResult {
    const calls = [...this.toolCalls.values()].filter((c) => c.name);
    const toolCalls: ToolCall[] | undefined = calls.length
      ? calls.map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, args: safeParse(c.args) }))
      : undefined;
    const message: ChatMessage = { role: "assistant", content: this.content, toolCalls };
    return { message, wantsToolCalls: !!toolCalls && toolCalls.length > 0 };
  }
}

function toApiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}
function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
