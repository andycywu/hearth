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
  /** Abort a turn if it exceeds this many milliseconds (default 30_000). */
  turnTimeoutMs?: number;
}

/** Raised when a turn exceeds its time budget. */
export class TurnTimeoutError extends Error {
  constructor(ms: number) {
    super(`Turn exceeded time budget of ${ms}ms`);
    this.name = "TurnTimeoutError";
  }
}

interface RunOptions {
  /** Optional caller-supplied signal to cancel the turn. */
  signal?: AbortSignal;
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
  private readonly turnTimeoutMs: number;

  constructor(private readonly opts: AgentOptions) {
    this.ctx = new ConversationContext(opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
    this.maxIterations = opts.maxIterations ?? 6;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 30_000;
    for (const tool of createTvTools(opts.platform)) this.tools.register(tool);
  }

  /** Expose the registry so hosts can register extra tools before running. */
  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  /**
   * Run one user turn. Bounded by both `maxIterations` (tool-call rounds) and
   * `turnTimeoutMs` (wall clock). A caller AbortSignal can cancel early.
   */
  async run(userInput: string, runOpts: RunOptions = {}): Promise<string> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.turnTimeoutMs);
    const signals = [timeout.signal, runOpts.signal].filter(Boolean) as AbortSignal[];
    const aborted = () => signals.some((s) => s.aborted);

    this.events.emit("turn:start", { input: userInput });
    this.ctx.add({ role: "user", content: userInput });

    try {
      for (let i = 0; i < this.maxIterations; i++) {
        if (aborted()) throw new TurnTimeoutError(this.turnTimeoutMs);

        const req = { messages: this.ctx.toMessages(), tools: this.tools.list() };
        const llm = this.opts.llm;
        const result = llm.completeStream
          ? await llm.completeStream(req, {
              onContentDelta: (delta) => this.events.emit("token", { delta }),
            })
          : await llm.complete(req);
        this.ctx.add(result.message);

        if (!result.wantsToolCalls) {
          const output = result.message.content;
          this.events.emit("turn:end", { output });
          return output;
        }

        for (const call of result.message.toolCalls ?? []) {
          if (aborted()) throw new TurnTimeoutError(this.turnTimeoutMs);
          this.events.emit("tool:call", { name: call.name, args: call.args });
          let toolResult: unknown;
          try {
            toolResult = await this.tools.call(call.name, call.args);
          } catch (err) {
            // Tool errors are fed back to the model as structured results so it
            // can recover (e.g. re-resolve an app id), rather than aborting.
            toolResult = { error: (err as Error).message, tool: call.name };
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
    } finally {
      clearTimeout(timer);
    }
  }
}
