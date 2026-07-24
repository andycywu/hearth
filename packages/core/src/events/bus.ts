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
  "tool:call": { name: string; args: unknown };
  "tool:result": { name: string; result: unknown };
  "error": { error: Error };
}
