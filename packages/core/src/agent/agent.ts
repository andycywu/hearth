import type { PlatformProvider } from "@tv-ai-agent/platform-api";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";
import { createTvTools, capabilitiesForPlatform } from "../tools/tv-tools.js";
import type { Capability } from "../capabilities/types.js";
import { CapabilityGraph } from "../capabilities/graph.js";
import { DeviceGraph } from "../devices/graph.js";
import { PolicyEngine } from "../policy/policy.js";
import { GoalPlanner } from "../planner/planner.js";
import { PlanExecutor } from "../planner/executor.js";
import { summarizeOutcome } from "../planner/report.js";
import type { Goal, PlanOutcome } from "../planner/types.js";
import { findSkill, type Skill } from "../skills/scenarios.js";
import { WorldModel } from "../world/model.js";
import { observeResult } from "../world/from-tools.js";
import { probeCapabilities, type CapabilityProbe } from "../tools/capability-probe.js";
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
  /**
   * Where the agent keeps what it knows about the room. Pass one to share it
   * with a planner or a perception source; otherwise the agent owns its own.
   */
  world?: WorldModel;
  /**
   * Put what the agent already knows into the system prompt. Default true.
   *
   * Off is for measuring the difference, and for a host that wants to build the
   * block itself. The facts still accumulate either way.
   */
  worldInPrompt?: boolean;
  /** Budget for that block, in characters. Default 400. */
  worldPromptChars?: number;
  /** What is in the room. Pass one built by the host's discovery; else empty. */
  devices?: DeviceGraph;
  /** May this happen? Defaults to the built-in risk rules. */
  policy?: PolicyEngine;
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
  /** What the agent believes about the room. See docs/world-model.md. */
  readonly world: WorldModel;
  private readonly tools = new ToolRegistry();
  /** What this device can do, and what it turned out it could not. */
  readonly capabilities = new CapabilityGraph();
  /** What is in the room. Empty until a host runs discovery. */
  readonly devices: DeviceGraph;
  /** May this happen? Consulted before every plan step. */
  readonly policy: PolicyEngine;
  /** Tool name -> the capability it performs, for reading results into state. */
  private readonly byTool = new Map<string, Capability>();
  private readonly ctx: ConversationContext;
  private readonly maxIterations: number;
  private readonly turnTimeoutMs: number;

  constructor(private readonly opts: AgentOptions) {
    this.ctx = new ConversationContext(opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
    this.maxIterations = opts.maxIterations ?? 6;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 30_000;
    this.world = opts.world ?? new WorldModel();
    this.devices = opts.devices ?? new DeviceGraph();
    this.policy = opts.policy ?? new PolicyEngine();
    for (const capability of capabilitiesForPlatform(opts.platform)) {
      this.capabilities.register(capability);
      if (capability.tool) this.byTool.set(capability.tool, capability);
    }
    for (const tool of createTvTools(opts.platform)) this.tools.register(tool);
    for (const tool of opts.tools ?? []) this.tools.register(tool);
    this.registerHelpTool();
  }

  /**
   * Ask the device which of its tools actually work here, and withdraw the rest.
   *
   * Explicitly called by the host after `platform.init()` rather than hidden
   * inside the first turn: it costs a handful of reads, and a cost on the boot
   * path should be visible at the place that pays it. Skipping it is allowed and
   * only means the first "what can you do?" may over-promise, since a tool still
   * withdraws itself the first time it answers `unsupported`.
   *
   * Safe to call again — a later probe can only withdraw more.
   */
  async probeCapabilities(): Promise<CapabilityProbe> {
    const probe = await probeCapabilities(this.opts.platform);
    const withdrawn: string[] = [];
    const tools: string[] = [];
    for (const id of probe.withdrawn) {
      const reason = probe.reasons[id] ?? "unsupported on this device";
      const tool = this.capabilities.get(id)?.tool;
      if (!this.capabilities.withdraw(id, reason)) continue;
      withdrawn.push(id);
      if (tool && this.withdrawTool(tool, reason, "probe", id)) tools.push(tool);
    }
    return { withdrawn, tools, notes: probe.notes, reasons: probe.reasons };
  }

  /**
   * Stop offering something the device cannot back — capability first, then the
   * tool it provided.
   *
   * The capability is the record; the tool is what the model sees. Withdrawing
   * only the tool used to mean the reason had to be reconstructed by matching on
   * the tool's *name* (`name.includes("volume")`), which is a naming convention
   * standing in for a data structure. Now the reason travels with the capability
   * and `?diag` can say which read withdrew what.
   */
  private withdraw(toolName: string, reason: string, at: "probe" | "call"): boolean {
    const capability = this.byTool.get(toolName);
    if (capability) this.capabilities.withdraw(capability.id, reason);
    return this.withdrawTool(toolName, reason, at, capability?.id);
  }

  /**
   * Remove a tool, once.
   *
   * `help` is never withdrawn: it lists what is left, and a device with no
   * capabilities at all should still be able to say so.
   */
  private withdrawTool(name: string, reason: string, at: "probe" | "call", capability?: string): boolean {
    if (name === "help") return false;
    if (!this.tools.unregister(name)) return false;
    this.events.emit("tool:withdrawn", { name, reason, at, ...(capability ? { capability } : {}) });
    return true;
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

  /**
   * Pursue a goal: plan against the world, check policy, execute, verify.
   *
   * The second path through the agent, and deliberately not a replacement for
   * the first. Conversation improvises tool calls, which is right for open
   * questions and wrong for "get the room ready to play a console" — that is a
   * *state* the user wants to be in, and a chat loop reaching it by improvisation
   * has no preconditions, no fallbacks, no verification and no record of how far
   * it got. Both paths share the same tools, the same policy and the same world.
   */
  async pursue(goal: Goal, runOpts: RunOptions = {}): Promise<PlanOutcome> {
    const planner = new GoalPlanner({ graph: this.capabilities, world: this.world });
    const plan = await planner.plan(goal);
    this.events.emit("plan:start", { plan });

    const executor = new PlanExecutor({
      graph: this.capabilities,
      world: this.world,
      tools: this.tools,
      policy: this.policy,
      // The host already has a confirmation UI wired to tool calls; a plan step
      // asks through the same door rather than growing a second one.
      ...(this.opts.confirm
        ? {
          confirm: (req) => this.opts.confirm!({
            name: req.capability.tool ?? req.capability.id,
            args: req.args,
            description: req.prompt,
          }),
        }
        : {}),
      onStep: (outcome) => this.events.emit("plan:step", { outcome }),
    });

    const outcome = await executor.run(plan, runOpts.signal);
    this.events.emit("plan:end", { outcome });
    return outcome;
  }

  /**
   * Pursue a named scenario, resolving its parameters first.
   *
   * `resolve` is where a skill looks at the room — which HDMI port the console
   * is on, how loud it is now — and where it can decline. A decline is reported
   * as `blocked` rather than as a failed plan, because "I don't know where your
   * PS5 is" and "I tried to switch and it didn't take" need different answers
   * from the user.
   */
  async pursueSkill(
    skill: Skill | string,
    params: Record<string, unknown> = {},
    runOpts: RunOptions = {},
  ): Promise<PlanOutcome> {
    const resolved = typeof skill === "string" ? findSkill(skill) : skill;
    if (!resolved) throw new Error(`Unknown skill: ${String(skill)}`);

    let goalParams: Record<string, unknown> | undefined = params;
    if (resolved.resolve) {
      goalParams = await resolved.resolve(params, {
        world: this.world,
        devices: this.devices,
        observe: (capabilityId) => this.observe(capabilityId),
      });
    }
    if (!goalParams) {
      const goal = resolved.goal(params);
      const blocked = resolved.blocked ?? `I can't work out what "${resolved.id}" means here.`;
      const outcome: PlanOutcome = {
        plan: { id: `plan-blocked-${resolved.id}`, goal, steps: [], createdAt: Date.now() },
        outcomes: [], achieved: false, unmet: goal.desiredState, blocked,
      };
      this.events.emit("plan:end", { outcome });
      return outcome;
    }
    return this.pursue(resolved.goal(goalParams), runOpts);
  }

  /**
   * Run one read capability and fold the answer into the world.
   *
   * The perception step, for the cases where planning needs a fact first — "a
   * bit quieter" is not a goal until you know how loud it is. Failures are
   * swallowed on purpose: the caller's next move is to check whether the world
   * knows, and an exception here would only be a longer way of saying no.
   */
  async observe(capabilityId: string): Promise<void> {
    const capability = this.capabilities.get(capabilityId);
    if (!capability?.tool || !this.tools.has(capability.tool)) return;
    try {
      const result = await this.tools.call(capability.tool, {});
      observeResult(this.world, capability, result);
    } catch {
      /* a read that failed leaves the world as it was, which is the truth */
    }
  }

  /** What a plan outcome amounts to, in a sentence. */
  describe(outcome: PlanOutcome): string {
    return summarizeOutcome(outcome);
  }

  /**
   * The conversation, with what the agent already knows folded into the system
   * prompt.
   *
   * Only known, fresh facts go in — padding the block with "volume: unknown"
   * teaches the model to distrust all of it — and it is rebuilt every round
   * rather than appended to the history, so a fact that changes mid-turn does
   * not appear twice with two different values.
   */
  private messages(): ChatMessage[] {
    const messages = this.ctx.toMessages();
    if (this.opts.worldInPrompt === false) return messages;
    const summary = this.world.summarize({ maxChars: this.opts.worldPromptChars ?? 400 });
    if (!summary) return messages;
    const system = messages[0];
    if (!system) return messages;
    return [
      { ...system, content: `${system.content}

What you already know about this room (do not re-read it unless the user doubts it):
${summary}` },
      ...messages.slice(1),
    ];
  }

  private async runLoop(userInput: string, deadline: Promise<never>): Promise<string> {
    this.events.emit("turn:start", { input: userInput });
    this.ctx.add({ role: "user", content: userInput });

    for (let i = 0; i < this.maxIterations; i++) {
      const req = { messages: this.messages(), tools: this.tools.list() };
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
        // Everything the TV just told us is also something the agent now knows.
        // Reading it here rather than in each tool is what makes the world model
        // arrive for free on every adapter, including ones written elsewhere:
        // the mapping is on the capability, and this is the one place a result
        // and its capability are both in hand.
        const capability = this.byTool.get(call.name);
        if (capability) observeResult(this.world, capability, toolResult);
        // A tool that reports `unsupported` has told us something permanent
        // about this device, so stop offering it. The result still goes back to
        // the model for this turn — it has to be able to explain the refusal —
        // but the tool is gone from the list it sees next time. Deliberately not
        // `failed`: that is a bad moment, not a missing capability, and
        // withdrawing over one would disable a working TV on a single hiccup.
        //
        // This is what covers what the boot probe cannot reach: `set_input_source`
        // has no side-effect-free read to probe with, since `getInputSource`
        // working says nothing about whether setting does.
        if (isUnsupportedResult(toolResult)) {
          this.withdraw(call.name, unsupportedMessage(toolResult), "call");
        }
        this.ctx.add({ role: "tool", toolCallId: call.id, content: JSON.stringify(toolResult) });
      }
    }
    const msg = "Reached the maximum number of tool iterations for this turn.";
    this.events.emit("turn:end", { output: msg });
    return msg;
  }
}

/** Is this tool result the envelope's "this device can't do that"? */
function isUnsupportedResult(result: unknown): boolean {
  return !!result
    && typeof result === "object"
    && (result as { ok?: unknown }).ok === false
    && (result as { error?: unknown }).error === "unsupported";
}

function unsupportedMessage(result: unknown): string {
  const message = (result as { message?: unknown })?.message;
  return typeof message === "string" && message ? message : "reported unsupported";
}
