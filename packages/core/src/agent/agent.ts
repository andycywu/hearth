import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import type { LlmClient } from "../llm/client.js";
import { ToolRegistry } from "../tools/registry.js";
import { createTvTools } from "../tools/tv-tools.js";
import { ConversationContext } from "../memory/context.js";
import { EventBus, type AgentEvents } from "../events/bus.js";

export interface AgentOptions {
  platform: PlatformProvider;
  llm: LlmClient;
  systemPrompt?: string;
  /** Safety cap on tool-call iterations per user turn. */
  maxIterations?: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are an on-device AI assistant embedded in a Smart TV.
You control the TV through the provided tools. Be concise. Prefer a single tool
call when the user's intent is clear. Never invent app ids — call list_apps first
if unsure.`;

/**
 * The Harness: a platform-agnostic agent loop. It feeds the user request to the
 * LLM, executes any requested tool calls against the platform HAL, feeds results
 * back, and repeats until the model produces a final answer.
 */
export class Agent {
  readonly events = new EventBus<AgentEvents>();
  private readonly tools = new ToolRegistry();
  private readonly ctx: ConversationContext;
  private readonly maxIterations: number;

  constructor(private readonly opts: AgentOptions) {
    this.ctx = new ConversationContext(opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
    this.maxIterations = opts.maxIterations ?? 6;
    for (const tool of createTvTools(opts.platform)) this.tools.register(tool);
  }

  /** Expose the registry so hosts can register extra tools before running. */
  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  async run(userInput: string): Promise<string> {
    this.events.emit("turn:start", { input: userInput });
    this.ctx.add({ role: "user", content: userInput });

    try {
      for (let i = 0; i < this.maxIterations; i++) {
        const result = await this.opts.llm.complete({
          messages: this.ctx.toMessages(),
          tools: this.tools.list(),
        });
        this.ctx.add(result.message);

        if (!result.wantsToolCalls) {
          const output = result.message.content;
          this.events.emit("turn:end", { output });
          return output;
        }

        for (const call of result.message.toolCalls ?? []) {
          this.events.emit("tool:call", { name: call.name, args: call.args });
          let toolResult: unknown;
          try {
            toolResult = await this.tools.call(call.name, call.args);
          } catch (err) {
            toolResult = { error: (err as Error).message };
          }
          this.events.emit("tool:result", { name: call.name, result: toolResult });
          this.ctx.add({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify(toolResult),
          });
        }
      }
      const msg = "Reached the maximum number of tool iterations for this turn.";
      this.events.emit("turn:end", { output: msg });
      return msg;
    } catch (err) {
      this.events.emit("error", { error: err as Error });
      throw err;
    }
  }
}
