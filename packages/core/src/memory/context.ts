import type { ChatMessage } from "../llm/client.js";

/**
 * Rolling conversation context with a simple token-budget trim. On constrained
 * MTK/NVT SoCs, memory and prompt size matter, so we cap history aggressively
 * and always keep the system prompt.
 */
export class ConversationContext {
  private messages: ChatMessage[] = [];

  constructor(private readonly systemPrompt: string, private readonly maxTurns = 12) {}

  add(message: ChatMessage): void {
    this.messages.push(message);
    // Keep only the most recent maxTurns (system prompt is prepended fresh).
    const overflow = this.messages.length - this.maxTurns;
    if (overflow > 0) this.messages.splice(0, overflow);
    // The cut lands wherever the count says, which can leave a tool result whose
    // assistant `tool_calls` was just trimmed away. Every OpenAI-compatible
    // server rejects that outright ("a message with role 'tool' must be a
    // response to a preceding message with tool_calls"), so the whole
    // conversation 400s from then on — not one bad turn, every turn after it.
    //
    // Invisible offline: the scripted client never looks at history shape. It
    // takes a mix of tool-using and plain turns to reach, which is what a real
    // session is: four questions, two commands, then an "open Netflix" (that
    // one is two calls).
    while (this.messages[0]?.role === "tool") this.messages.shift();
  }

  toMessages(): ChatMessage[] {
    return [{ role: "system", content: this.systemPrompt }, ...this.messages];
  }

  /** Number of stored (non-system) messages currently retained. */
  get length(): number {
    return this.messages.length;
  }

  /** Snapshot of stored messages (excludes the system prompt) for persistence. */
  dump(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** Replace stored messages from a snapshot (applies the same trim cap). */
  restore(messages: ChatMessage[]): void {
    this.messages = [];
    for (const m of messages) this.add(m);
  }

  reset(): void {
    this.messages = [];
  }
}
