import type { Agent } from "@tv-ai-agent/core";
import { formatToolCall } from "./format.js";

/**
 * What every renderer needs to draw a turn, and nothing more. Values are
 * *undecorated* — prefixes ("· ", "⚠ ") and truncation are the renderer's job,
 * because a DOM overlay, a 2D canvas and a WebGL scene each have different room.
 */
export interface AgentViewState {
  /** Streamed tokens so far, or the final output when the model didn't stream. */
  reply: string;
  /** Last tool call, e.g. `set_volume(level=30)`. Empty when idle. */
  activity: string;
  /** Last error message. Cleared when the next turn starts. */
  error: string;
  /** True between `turn:start` and `turn:end`/`error`. */
  busy: boolean;
  /** True when `reply` came from streamed tokens rather than the final output. */
  streamed: boolean;
}

export interface AgentViewModel {
  /** Current state (a copy — safe to keep). */
  snapshot(): AgentViewState;
  /** Observe every change. Returns an unsubscribe function. */
  subscribe(cb: (state: AgentViewState) => void): () => void;
  /** Unsubscribe from the agent and drop all observers. */
  destroy(): void;
}

/**
 * The agent-event → view-state wiring, shared by every renderer (DOM overlay,
 * 2D canvas, Lightning 3 / Blits WebGL). Pure logic: no DOM, no framework, so
 * it is unit-testable and a new renderer only has to draw.
 */
export function createAgentViewModel(agent: Agent): AgentViewModel {
  const state: AgentViewState = { reply: "", activity: "", error: "", busy: false, streamed: false };
  const subs = new Set<(state: AgentViewState) => void>();
  const emit = (): void => {
    const snap = { ...state };
    subs.forEach((cb) => cb(snap));
  };

  const unsub: Array<() => void> = [
    agent.events.on("turn:start", () => {
      state.reply = "";
      state.activity = "";
      state.error = "";
      state.busy = true;
      state.streamed = false;
      emit();
    }),
    agent.events.on("token", ({ delta }) => {
      state.reply += delta;
      state.streamed = true;
      emit();
    }),
    agent.events.on("tool:call", ({ name, args }) => {
      state.activity = formatToolCall(name, args);
      emit();
    }),
    agent.events.on("turn:end", ({ output }) => {
      // Non-streaming clients only produce the final output; keep whatever the
      // stream already showed so a streamed reply isn't overwritten.
      if (!state.reply) state.reply = output;
      state.activity = "";
      state.busy = false;
      emit();
    }),
    agent.events.on("error", ({ error }) => {
      state.error = error.message;
      state.activity = "";
      state.busy = false;
      emit();
    }),
  ];

  return {
    snapshot: () => ({ ...state }),
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    destroy: () => {
      unsub.forEach((u) => u());
      subs.clear();
    },
  };
}
