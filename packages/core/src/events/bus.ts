import type { Plan, PlanOutcome, StepOutcome } from "../planner/types.js";
import type { PolicyAuditEntry } from "../policy/policy.js";
import type { PerceptionEvent } from "../perception/events.js";
import type { PerceptionGrant } from "../perception/manager.js";

export type Listener<T> = (payload: T) => void;

/** Minimal typed event bus used to decouple runtime components. */
export class EventBus<Events = Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();

  on<K extends keyof Events>(event: K, cb: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => set.delete(cb);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }
}

export interface AgentEvents {
  "turn:start": { input: string };
  "turn:end": { output: string };
  "token": { delta: string };
  "tool:call": { name: string; args: unknown };
  "tool:result": { name: string; result: unknown };
  /**
   * A tool was withdrawn because this device cannot do it — either the boot
   * probe said so, or the tool itself answered `unsupported`. Hosts surface it
   * in `?diag`; nothing has to listen.
   */
  "tool:withdrawn": { name: string; reason: string; at: "probe" | "call"; capability?: string };
  /**
   * A goal-driven run, as opposed to a conversational turn. Both paths exist:
   * chat improvises tool calls, a plan is derived from a goal and verified step
   * by step. Renderers show them the same way; the events are separate because
   * "what the agent is doing" is genuinely different information.
   */
  "plan:start": { plan: Plan };
  "plan:step": { outcome: StepOutcome };
  "plan:end": { outcome: PlanOutcome };
  /**
   * Every policy decision, from either path. This is what makes "why did the TV
   * do that?" — and "why did it refuse?" — answerable after the fact.
   */
  "policy:decision": { entry: PolicyAuditEntry };
  /**
   * A sensor reading that got through the gate. Already stripped of raw capture,
   * so a host can log or display it without thinking about it.
   */
  "perception:event": { event: PerceptionEvent; sourceId: string };
  /**
   * A sensor grant taken or dropped — what a host wires its "camera is live"
   * indicator to. `grant: undefined` means the sensor is off.
   */
  "perception:grant": { grant: PerceptionGrant | undefined; sourceId: string };
  "error": { error: Error };
}
