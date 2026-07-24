import type {
  LlmClient, CompletionRequest, CompletionResult, ChatMessage, ToolCall,
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
  return {
    id: `openai:${opts.model}`,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const body = {
        model: opts.model,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 512,
        messages: req.messages.map(toApiMessage),
        tools: req.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: {
              type: "object",
              properties: t.parameters,
              required: Object.entries(t.parameters)
                .filter(([, p]) => p.required)
                .map(([k]) => k),
            },
          },
        })),
        tool_choice: "auto",
      };
      const res = await doFetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
      const json: any = await res.json();
      const choice = json.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] | undefined = choice.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        args: safeParse(tc.function.arguments),
      }));
      const message: ChatMessage = {
        role: "assistant",
        content: choice.content ?? "",
        toolCalls,
      };
      return { message, wantsToolCalls: !!toolCalls && toolCalls.length > 0 };
    },
  };
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
