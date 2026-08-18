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
  "error": { error: Error };
}
