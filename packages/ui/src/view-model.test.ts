import { describe, it, expect } from "vitest";
import { EventBus, type AgentEvents } from "@tv-ai-agent/core";
import type { Agent } from "@tv-ai-agent/core";
import { createAgentViewModel, type AgentViewState } from "./view-model.js";

/**
 * The view-model only touches `agent.events`, so a bare bus is enough — no
 * platform, no LLM, no DOM.
 */
function fakeAgent(): { agent: Agent; events: EventBus<AgentEvents> } {
  const events = new EventBus<AgentEvents>();
  return { agent: { events } as unknown as Agent, events };
}

describe("createAgentViewModel", () => {
  it("starts empty and idle", () => {
    const { agent } = fakeAgent();
    expect(createAgentViewModel(agent).snapshot()).toEqual({
      reply: "", activity: "", error: "", busy: false, streamed: false,
    });
  });

  it("accumulates streamed tokens and marks the reply as streamed", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    events.emit("turn:start", { input: "hi" });
    events.emit("token", { delta: "Vol" });
    events.emit("token", { delta: "ume set" });
    const s = vm.snapshot();
    expect(s.reply).toBe("Volume set");
    expect(s.streamed).toBe(true);
    expect(s.busy).toBe(true);
  });

  it("records the last tool call as undecorated activity", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    events.emit("tool:call", { name: "set_volume", args: { level: 30 } });
    expect(vm.snapshot().activity).toBe("set_volume(level=30)");
    events.emit("tool:call", { name: "list_apps", args: {} });
    expect(vm.snapshot().activity).toBe("list_apps()");
  });

  it("falls back to the final output when the client didn't stream", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    events.emit("turn:start", { input: "hi" });
    events.emit("tool:call", { name: "set_volume", args: { level: 30 } });
    events.emit("turn:end", { output: "Done." });
    expect(vm.snapshot()).toEqual({
      reply: "Done.", activity: "", error: "", busy: false, streamed: false,
    });
  });

  it("keeps a streamed reply instead of overwriting it at turn:end", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    events.emit("turn:start", { input: "hi" });
    events.emit("token", { delta: "Streamed" });
    events.emit("turn:end", { output: "Streamed" });
    expect(vm.snapshot().reply).toBe("Streamed");
    expect(vm.snapshot().streamed).toBe(true);
  });

  it("captures errors, clears activity and stops being busy", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    events.emit("turn:start", { input: "hi" });
    events.emit("tool:call", { name: "launch_app", args: { appId: "x" } });
    events.emit("error", { error: new Error("offline") });
    const s = vm.snapshot();
    expect(s.error).toBe("offline");
    expect(s.activity).toBe("");
    expect(s.busy).toBe(false);
  });

  it("clears the previous turn's reply and error on turn:start", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    events.emit("turn:end", { output: "old" });
    events.emit("error", { error: new Error("boom") });
    events.emit("turn:start", { input: "again" });
    expect(vm.snapshot()).toEqual({
      reply: "", activity: "", error: "", busy: true, streamed: false,
    });
  });

  it("notifies subscribers on every change and stops after unsubscribe", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    const seen: AgentViewState[] = [];
    const off = vm.subscribe((s) => seen.push(s));
    events.emit("turn:start", { input: "hi" });
    events.emit("token", { delta: "a" });
    expect(seen.map((s) => s.reply)).toEqual(["", "a"]);
    off();
    events.emit("token", { delta: "b" });
    expect(seen).toHaveLength(2);
    expect(vm.snapshot().reply).toBe("ab"); // still tracking, just not notifying
  });

  it("hands subscribers an isolated copy, not the live state", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    let captured: AgentViewState | undefined;
    vm.subscribe((s) => { captured = s; });
    events.emit("token", { delta: "a" });
    events.emit("token", { delta: "b" });
    expect(captured?.reply).toBe("ab");
    captured!.reply = "tampered";
    expect(vm.snapshot().reply).toBe("ab");
  });

  it("detaches from the agent on destroy", () => {
    const { agent, events } = fakeAgent();
    const vm = createAgentViewModel(agent);
    let calls = 0;
    vm.subscribe(() => { calls++; });
    vm.destroy();
    events.emit("token", { delta: "ignored" });
    expect(calls).toBe(0);
    expect(vm.snapshot().reply).toBe("");
  });
});
