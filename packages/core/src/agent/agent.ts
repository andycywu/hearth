import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import type { LlmClient } from "../llm/client.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";
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
  /**
   * Extra tools to register alongside the built-in TV tools — the extension
   * point for app- or plugin-specific capabilities. See docs/extending.md.
   */
  tools?: Tool[];
  /**
   * When set, conversation history is auto-saved to `platform.storage` under
   * this key after every turn. Call `restore()` at startup to reload it.
   */
  persistKey?: string;
  /**
   * Called before executing a tool whose spec has `confirm: true`. Return false
   * to decline; the model receives a structured "declined" result and can adapt.
   * When unset, confirm-required tools run without prompting (opt-in guard).
   */
  confirm?: (req: ConfirmRequest) => boolean | Promise<boolean>;
}

export interface ConfirmRequest {
  name: string;
  args: Record<string, unknown>;
  description: string;
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
if unsure. Always reply in the same language the user used (e.g. answer in
Traditional Chinese if they wrote Chinese).`;

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
    for (const tool of opts.tools ?? []) this.tools.register(tool);
    this.registerHelpTool();
  }

  /** A built-in tool so the user can ask "what can you do?". */
  private registerHelpTool(): void {
    this.tools.register({
      spec: {
        name: "help",
        description: "List the things the assistant can do (the available tools).",
        parameters: {},
      },
      execute: async () =>
        this.tools.list()
          .filter((s) => s.name !== "help")
          .map((s) => ({ name: s.name, description: s.description })),
    });
  }

  /** Expose the registry so hosts can register extra tools before running. */
  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  /** Number of retained conversation messages (excludes the system prompt). */
  get historyLength(): number {
    return this.ctx.length;
  }

  /** Clear conversation history (e.g. when the user starts a new session). */
  reset(): void {
    this.ctx.reset();
    if (this.opts.persistKey) void this.opts.platform.storage.delete(this.opts.persistKey);
  }

  /**
   * Reload persisted history from `platform.storage` (requires `persistKey`).
   * Returns true if history was restored. Call once at startup.
   */
  async restore(): Promise<boolean> {
    if (!this.opts.persistKey) return false;
    const raw = await this.opts.platform.storage.get(this.opts.persistKey);
    if (!raw) return false;
    try {
      this.ctx.restore(JSON.parse(raw));
      return true;
    } catch {
      return false;
    }
  }

  private async persist(): Promise<void> {
    if (!this.opts.persistKey) return;
    try {
      await this.opts.platform.storage.set(this.opts.persistKey, JSON.stringify(this.ctx.dump()));
    } catch {
      /* storage is best-effort; never fail a turn on persistence */
    }
  }

  /**
   * Run one user turn. Bounded by both `maxIterations` (tool-call rounds) and
   * `turnTimeoutMs` (wall clock). A caller AbortSignal can cancel early.
   */
  async run(userInput: string, runOpts: RunOptions = {}): Promise<string> {
    // A deadline (and optional caller signal) that can reject the whole turn,
    // even while it is awaiting a slow/hung LLM call — Promise.race is what makes
    // the timeout actually interrupt, not just a between-steps check.
    let onTimeout: ((e: Error) => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      onTimeout = reject;
    });
    const timer = setTimeout(() => onTimeout?.(new TurnTimeoutError(this.turnTimeoutMs)), this.turnTimeoutMs);
    const onAbort = () => onTimeout?.(new TurnTimeoutError(this.turnTimeoutMs));
    runOpts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const output = await Promise.race([this.runLoop(userInput, deadline), deadline]);
      await this.persist();
      return output;
    } catch (err) {
      this.events.emit("error", { error: err as Error });
      throw err;
    } finally {
      clearTimeout(timer);
      runOpts.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async runLoop(userInput: string, deadline: Promise<never>): Promise<string> {
    this.events.emit("turn:start", { input: userInput });
    this.ctx.add({ role: "user", content: userInput });

    for (let i = 0; i < this.maxIterations; i++) {
      const req = { messages: this.ctx.toMessages(), tools: this.tools.list() };
      const llm = this.opts.llm;
      // Race the LLM call against the deadline so a hung call is interrupted.
      const result = await Promise.race([
        llm.completeStream
          ? llm.completeStream(req, { onContentDelta: (delta) => this.events.emit("token", { delta }) })
          : llm.complete(req),
        deadline,
      ]);
      this.ctx.add(result.message);

      if (!result.wantsToolCalls) {
        const output = result.message.content;
        this.events.emit("turn:end", { output });
        return output;
      }

      for (const call of result.message.toolCalls ?? []) {
        this.events.emit("tool:call", { name: call.name, args: call.args });

        // Confirmation gate for higher-impact tools (input switch, launch, …).
        const spec = this.tools.getSpec(call.name);
        if (spec?.confirm && this.opts.confirm) {
          const approved = await this.opts.confirm({
            name: call.name,
            args: call.args,
            description: spec.description,
          });
          if (!approved) {
            const declined = { declined: true, error: "Action declined by the user." };
            this.events.emit("tool:result", { name: call.name, result: declined });
            this.ctx.add({ role: "tool", toolCallId: call.id, content: JSON.stringify(declined) });
            continue;
          }
        }

        let toolResult: unknown;
        try {
          toolResult = await Promise.race([this.tools.call(call.name, call.args), deadline]);
        } catch (err) {
          // Tool errors are fed back to the model as structured results so it
          // can recover (e.g. re-resolve an app id), rather than aborting.
          toolResult = { error: (err as Error).message, tool: call.name };
        }
        this.events.emit("tool:result", { name: call.name, result: toolResult });
        this.ctx.add({ role: "tool", toolCallId: call.id, content: JSON.stringify(toolResult) });
      }
    }
    const msg = "Reached the maximum number of tool iterations for this turn.";
    this.events.emit("turn:end", { output: msg });
    return msg;
  }
}
