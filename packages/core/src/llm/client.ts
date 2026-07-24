import type { ToolSpec } from "../tools/registry.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that request tool calls. */
  toolCalls?: ToolCall[];
  /** Present on tool messages; links a result back to a call. */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
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
