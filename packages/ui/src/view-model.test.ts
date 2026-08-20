import { describe, it, expect } from "vitest";
import { EventBus, type AgentEvents } from "@hearthkit/core";
import type { Agent } from "@hearthkit/core";
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
      listening: false, speaking: false, phase: "idle",
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
      listening: false, speaking: false, phase: "idle",
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
      listening: false, speaking: false, phase: "thinking",
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

  describe("phase, for an avatar to draw", () => {
    it("is thinking while a turn is in flight, idle after", () => {
      const { agent, events } = fakeAgent();
      const vm = createAgentViewModel(agent);
      events.emit("turn:start", { input: "hi" });
      expect(vm.snapshot().phase).toBe("thinking");
      events.emit("turn:end", { input: "hi", output: "done" });
      expect(vm.snapshot().phase).toBe("idle");
    });

    it("is idle again after an error, not stuck thinking", () => {
      const { agent, events } = fakeAgent();
      const vm = createAgentViewModel(agent);
      events.emit("turn:start", { input: "hi" });
      events.emit("error", { error: new Error("nope") });
      expect(vm.snapshot().phase).toBe("idle");
    });

    it("takes listening and speaking from outside — the agent has no mic", () => {
      const { agent } = fakeAgent();
      const vm = createAgentViewModel(agent);
      vm.setListening(true);
      expect(vm.snapshot().phase).toBe("listening");
      vm.setListening(false);
      vm.setSpeaking(true);
      expect(vm.snapshot().phase).toBe("speaking");
      vm.setSpeaking(false);
      expect(vm.snapshot().phase).toBe("idle");
    });

    it("shows an open microphone above everything else", () => {
      // Privacy signal: if the room is being heard the viewer must see it, even
      // mid-turn or mid-reply.
      const { agent, events } = fakeAgent();
      const vm = createAgentViewModel(agent);
      events.emit("turn:start", { input: "hi" });
      vm.setSpeaking(true);
      vm.setListening(true);
      expect(vm.snapshot().phase).toBe("listening");
    });

    it("prefers speaking to thinking, so a streaming reply doesn't flicker", () => {
      const { agent, events } = fakeAgent();
      const vm = createAgentViewModel(agent);
      events.emit("turn:start", { input: "hi" });
      vm.setSpeaking(true);
      expect(vm.snapshot().phase).toBe("speaking");
    });

    it("notifies subscribers when only the phase changed", () => {
      const { agent } = fakeAgent();
      const vm = createAgentViewModel(agent);
      const phases: string[] = [];
      vm.subscribe((s) => phases.push(s.phase));
      vm.setListening(true);
      vm.setListening(true);   // no-op, must not emit again
      vm.setListening(false);
      expect(phases).toEqual(["listening", "idle"]);
    });
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

  describe("a plan, which is the other kind of turn", () => {
    const plan = {
      id: "p1",
      goal: { id: "gaming_session_active", desiredState: [] },
      steps: [{ id: "s1", action: { capabilityId: "tv.input.switch", args: {} }, preconditions: [], expectedResult: [] }],
      createdAt: 0,
    };
    const step = (status: string) => ({
      step: plan.steps[0]!,
      status,
      attempts: 1,
    }) as never;

    it("shows the same busy/activity a renderer already draws", () => {
      const { agent, events } = fakeAgent();
      const vm = createAgentViewModel(agent);
      const seen: AgentViewState[] = [];
      vm.subscribe((s) => seen.push(s));

      events.emit("plan:start", { plan } as never);
      expect(vm.snapshot()).toMatchObject({ busy: true, phase: "thinking", activity: "planning gaming_session_active" });

      events.emit("plan:step", { outcome: step("verified") });
      expect(vm.snapshot().activity).toBe("tv.input.switch — verified");

      events.emit("plan:end", {
        outcome: { plan, outcomes: [step("verified")], achieved: true, unmet: [] },
      } as never);
      expect(vm.snapshot()).toMatchObject({ busy: false, activity: "", phase: "idle" });
      expect(vm.snapshot().reply).toMatch(/^Done: tv\.input\.switch/);
    });

    it("reports a step that could not be checked as exactly that", () => {
      const { agent, events } = fakeAgent();
      const vm = createAgentViewModel(agent);
      events.emit("plan:end", {
        outcome: { plan, outcomes: [step("unverified")], achieved: true, unmet: [] },
      } as never);
      // Never "done" for something nothing on this device can confirm.
      expect(vm.snapshot().reply).toMatch(/can't confirm it/);
      expect(vm.snapshot().reply).not.toMatch(/^Done/);
    });
  });
});
