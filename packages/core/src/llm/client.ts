import type { ToolSpec } from "../tools/registry.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that request tool calls. */
  toolCalls?: ToolCall[];
  /** Present on tool messages; links a result back to a call. */
  toolCallId?: string;
  /**
   * Whatever the service attached to this assistant message besides its role, text and tool calls — sent back
   * verbatim on the next turn. Hearth does not read it. See `ToolCall.providerData`.
   */
  providerData?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Whatever the service attached to this call besides `id`, `type` and the function's `name` and `arguments` —
   * for the hosted ModelPilot, a Gemini call's `provider_metadata`, which the next turn must carry back or the
   * provider refuses the tool result. Hearth does not interpret it and does not drop it: it is kept as received
   * (`function` holds extras found inside the function object) and sent back on the same call.
   */
  providerData?: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResult {
  message: ChatMessage;
  /** Whether the model requested one or more tool calls. */
  wantsToolCalls: boolean;
}

/** Callbacks invoked while a streaming completion is in progress. */
export interface StreamHandlers {
  /** Called for each incremental chunk of assistant text. */
  onContentDelta?(delta: string): void;
}

/**
 * Provider-neutral LLM interface. A cloud OpenAI-compatible endpoint and an
 * on-device local model both implement this, so the agent loop never cares
 * where inference runs — important for privacy-sensitive on-device TV use.
 *
 * `completeStream` is optional: clients that support token streaming implement
 * it to emit incremental text (for a responsive 10-foot UI) while still
 * resolving to the same CompletionResult as `complete`.
 */
export interface LlmClient {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  completeStream?(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult>;
}
