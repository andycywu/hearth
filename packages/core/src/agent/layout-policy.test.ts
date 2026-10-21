import { describe, it, expect } from "vitest";
import type { DisplayControl, ScreenLayout } from "@hearthkit/platform-api";
import { EventBus, type AgentEvents } from "../events/bus.js";
import { createLayoutPolicy } from "./layout-policy.js";

/** A display that records what it was asked, and a clock the test turns by hand. */
function setup(opts: { resting?: ScreenLayout; failWith?: Error } = {}) {
  const events = new EventBus<AgentEvents>();
  const calls: ScreenLayout[] = [];
  const display: DisplayControl = {
    getLayout: async () => calls.at(-1),
    setLayout: async (l) => { if (opts.failWith) throw opts.failWith; calls.push(l); },
  };
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const policy = createLayoutPolicy({
    events, display, ...(opts.resting ? { resting: opts.resting } : {}), settleMs: 6000, log: () => {},
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  });
  const tick = async () => { for (const t of timers.splice(0)) if (t.live) t.fn(); await Promise.resolve(); await Promise.resolve(); };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { events, calls, policy, tick, flush, timers };
}

const stepEvent = (layout: string, status = "verified") => ({
  outcome: { step: { action: { capabilityId: "tv.display.set_layout", args: { layout } } }, status, attempts: 1 },
}) as unknown as AgentEvents["plan:step"];

describe("layout policy", () => {
  it("touches nothing until the agent has something to do", () => {
    expect(setup().calls).toEqual([]);
  });

  it("borrows the screen from a full-screen picture for a turn, and gives it back after the settle time", async () => {
    const { events, calls, tick, flush, timers } = setup();
    events.emit("turn:start", { input: "hi" });
    await flush();
    expect(calls).toEqual(["panel"]);
    events.emit("turn:end", { output: "hello" });
    await flush();
    expect(calls).toEqual(["panel"]);                       // not yet: the reply has to be readable
    expect(timers[0]?.ms).toBe(6000);
    await tick();
    expect(calls).toEqual(["panel", "fullscreen"]);
  });

  it("does not hand the screen back while another turn or plan is still running, and cancels a pending return", async () => {
    const { events, calls, tick, flush } = setup();
    events.emit("turn:start", { input: "a" });
    events.emit("plan:start", { plan: {} as never });
    await flush();
    events.emit("turn:end", { output: "" });
    await tick();
    expect(calls).toEqual(["panel"]);                       // the plan is still running
    events.emit("plan:end", { outcome: {} as never });
    events.emit("turn:start", { input: "again" });          // new activity before the settle time cancels the return
    await flush();
    await tick();
    expect(calls).toEqual(["panel"]);
  });

  it("makes no change when the picture already rests on the panel or on Hearth", async () => {
    for (const resting of ["panel", "hearth"] as const) {
      const { events, calls, tick, flush } = setup({ resting });
      events.emit("turn:start", { input: "hi" });
      events.emit("turn:end", { output: "" });
      await flush();
      await tick();
      expect(calls, resting).toEqual([]);
    }
  });

  it("treats a layout the person asked for as the new resting place", async () => {
    const { events, calls, tick, flush, policy } = setup();
    events.emit("turn:start", { input: "hide the picture" });
    await flush();
    events.emit("tool:call", { name: "set_screen_layout", args: { layout: "hearth" } });
    events.emit("tool:result", { name: "set_screen_layout", result: { ok: true } });
    events.emit("turn:end", { output: "done" });
    await tick();
    expect(policy.resting).toBe("hearth");
    expect(calls).toEqual(["panel"]);                       // the tool set hearth itself; the policy did not undo it on the way out
  });

  it("does not adopt a layout the television refused", async () => {
    const { events, policy } = setup();
    events.emit("tool:call", { name: "set_screen_layout", args: { layout: "hearth" } });
    events.emit("tool:result", { name: "set_screen_layout", result: { ok: false, error: "unsupported", message: "no" } });
    expect(policy.resting).toBe("fullscreen");
  });

  it("adopts a planned layout once its step ran, and not a failed one", async () => {
    const { events, policy } = setup();
    events.emit("plan:step", stepEvent("panel", "failed"));
    expect(policy.resting).toBe("fullscreen");
    events.emit("plan:step", stepEvent("panel", "verified"));
    expect(policy.resting).toBe("panel");
  });

  it("logs and carries on when the display refuses, rather than throwing into the turn", async () => {
    const { events, flush, calls } = setup({ failWith: new Error("busy") });
    expect(() => events.emit("turn:start", { input: "hi" })).not.toThrow();
    await flush();
    expect(calls).toEqual([]);
  });

  it("stops listening when disposed", async () => {
    const { events, calls, flush, policy } = setup();
    policy.dispose();
    events.emit("turn:start", { input: "hi" });
    await flush();
    expect(calls).toEqual([]);
  });
});
