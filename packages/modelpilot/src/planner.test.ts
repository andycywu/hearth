import { describe, it, expect } from "vitest";
import { createWebAdapter } from "@hearthkit/adapter-web";
import {
  Agent, DeviceGraph, W,
  type CompletionResult, type LlmClient, type PlanOutcome,
} from "@hearthkit/core";
import { createModelPilotClient } from "./client.js";
import { createModelPilotPlanner } from "./planner.js";
import { parseActionPlan } from "./action-plan.js";
import type { ModelPilotMode } from "./config.js";
import type { ModelPilotTelemetry } from "./telemetry.js";

/**
 * The three modes, judged by the only question that matters on a television:
 * **did the device do something different?**
 *
 * A mock ModelPilot — an injected `fetch`, never the production service — so
 * these run in CI with no network and no credential.
 */

const KEY = "mp_test_key_0123456789";

/** A mock ModelPilot server: one canned answer, and a record of what it was sent. */
function mockModelPilot(answer: unknown, opts: { status?: number; hang?: boolean } = {}) {
  const requests: unknown[] = [];
  const fetchImpl = ((_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body ?? "{}")));
    if (opts.hang) {
      return new Promise((_r, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return Promise.resolve(new Response(JSON.stringify(answer), { status: opts.status ?? 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/**
 * An answer in the shape the service actually returns: an OpenAI completion
 * whose content is a string, plus the `modelpilot` routing extension.
 *
 * `evaluation_status: "unverified"` is not a special case here — it is what
 * every fresh completion carries, which is exactly why nothing may gate on it.
 */
const answer = (plan: unknown, meta: Record<string, unknown> = {}): unknown => ({
  id: "chatcmpl-1",
  model: "openai-mini",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: typeof plan === "string" ? plan : JSON.stringify(plan),
    },
    finish_reason: "stop",
  }],
  modelpilot: {
    request_id: "req-abc", selected_model: "openai-mini", provider: "openai",
    fallback_count: 0, actual_cost: 0.004, baseline_cost: 0.031,
    evaluation_status: "unverified",
    ...meta,
  },
});

const switchToHdmi3 = {
  action: "set_input", target: "tv",
  parameters: { source: "hdmi3" },
  expected_state: { "tv.input": "hdmi3" },
  risk: "low", reason: "the set-top box is on HDMI3",
};

function setup(opts: {
  mode: ModelPilotMode;
  answer?: unknown;
  status?: number;
  hang?: boolean;
  onUnavailable?: "local" | "refuse";
  breakInput?: boolean;
}) {
  const platform = createWebAdapter();
  // A TV that takes the write and stays where it was — the case the local
  // verifier exists for, used by the recovery test.
  if (opts.breakInput) platform.system.setInputSource = async () => {};

  const devices = new DeviceGraph();
  devices.observe({
    id: "ps5", name: "PlayStation 5", type: "game_console",
    connection: { kind: "hdmi", port: "hdmi2" }, source: "manual", confidence: 1,
  });

  const silent: LlmClient = {
    id: "silent",
    complete: async (): Promise<CompletionResult> => ({
      wantsToolCalls: false, message: { role: "assistant", content: "ok" },
    }),
  };

  const mock = mockModelPilot(opts.answer ?? answer(switchToHdmi3), {
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.hang ? { hang: true } : {}),
  });
  const client = createModelPilotClient({
    baseUrl: "https://modelpilot.test", apiKey: KEY, fetchImpl: mock.fetchImpl, timeoutMs: 30,
  });

  const telemetry: ModelPilotTelemetry[] = [];
  const agent = new Agent({
    platform, llm: silent, devices, confirm: () => true, llmPlanning: true,
  });
  const planner = createModelPilotPlanner({
    client, mode: opts.mode,
    graph: agent.capabilities, world: agent.world, devices: agent.devices,
    telemetry: (record) => telemetry.push(record),
    ...(opts.onUnavailable ? { onUnavailable: opts.onUnavailable } : {}),
  });

  // The seam: whatever plans, the executor, the policy and the local verifier
  // are the same ones.
  const agentWithMp = new Agent({
    platform, llm: silent, devices, confirm: () => true, llmPlanning: true,
    world: agent.world, planner,
  });

  return { agent: agentWithMp, platform, planner, telemetry, requests: mock.requests };
}

const shapes = (outcome: PlanOutcome): string[] =>
  outcome.outcomes.map((o) => `${o.step.action.capabilityId}:${o.status}`);

/** A goal the deterministic planner cannot measure, so the planner is consulted. */
const freeform = { id: "freeform", intent: "put the news on", desiredState: [] };

describe("mode: off", () => {
  it("never calls ModelPilot", async () => {
    const { agent, requests, telemetry } = setup({ mode: "off" });
    await agent.pursue(freeform);
    expect(requests).toEqual([]);
    expect(telemetry[0]).toMatchObject({ status: "skipped", mode: "off" });
  });
});

describe("mode: shadow", () => {
  it("calls ModelPilot but leaves the device behaviour identical", async () => {
    const withMp = setup({ mode: "shadow" });
    const outcome = await withMp.agent.pursue({
      id: "input_switched", desiredState: [{ path: W.tvInput, equals: "hdmi2" }],
    });

    // The engine suggested HDMI3. The TV went to HDMI2, which is what the local
    // plan said — shadow mode observes, it does not steer.
    expect(await withMp.platform.system.getInputSource()).toBe("hdmi2");
    expect(shapes(outcome)).toEqual(["tv.input.switch:verified"]);

    const off = setup({ mode: "off" });
    const same = await off.agent.pursue({
      id: "input_switched", desiredState: [{ path: W.tvInput, equals: "hdmi2" }],
    });
    expect(shapes(outcome)).toEqual(shapes(same));
  });

  it("keeps the suggestion, the ids and the disagreement", async () => {
    const { agent, planner, telemetry } = setup({ mode: "shadow" });
    await agent.pursue({ id: "input_switched", desiredState: [{ path: W.tvInput, equals: "hdmi2" }] });

    expect(planner.shadow).toHaveLength(1);
    expect(planner.shadow[0]).toMatchObject({
      requestId: "req-abc", selectedModel: "openai-mini", agreement: "different",
      localSteps: ["tv.input.switch(source=hdmi2)"],
      remoteSteps: ["tv.input.switch(source=hdmi3)"],
    });
    expect(telemetry[0]).toMatchObject({
      mode: "shadow", status: "ok", modelpilot_request_id: "req-abc",
      selected_model: "openai-mini", actual_cost: 0.004,
      // The saving claim, next to what it is a saving against.
      baseline_cost: 0.031,
      // Recorded, never acted on.
      evaluation_status: "unverified",
      shadow_agreement: "different",
    });
  });

  it("still runs the local plan when ModelPilot fails", async () => {
    const { agent, platform, telemetry } = setup({ mode: "shadow", status: 500 });
    await agent.pursue({ id: "input_switched", desiredState: [{ path: W.tvInput, equals: "hdmi2" }] });
    expect(await platform.system.getInputSource()).toBe("hdmi2");
    expect(telemetry[0]).toMatchObject({ status: "error" });
    expect(telemetry[0]?.fallback_reason).toMatch(/server/);
  });
});

describe("running out of quota is an availability problem", () => {
  it("falls back to the local plan when the tenant's month is spent", async () => {
    // 1000 requests a month on the Free plan, counted per *tenant*: one heavy
    // household on a shared key spends it for every television on that key. A
    // TV that stops working then is a worse product than one that plans locally.
    const { agent, platform, telemetry } = setup({
      mode: "enforce", status: 429,
      answer: { error: { message: "Monthly request limit reached", type: "rate_limit_error" } },
    });
    await agent.pursue({ id: "input_switched", desiredState: [{ path: W.tvInput, equals: "hdmi2" }] });

    expect(await platform.system.getInputSource()).toBe("hdmi2");
    expect(telemetry[0]).toMatchObject({ status: "error", mode: "enforce" });
    expect(telemetry[0]?.fallback_reason).toMatch(/rate_limited/);
  });
});

describe("mode: enforce", () => {
  it("uses ModelPilot's plan", async () => {
    const { agent, platform, telemetry } = setup({ mode: "enforce" });
    const outcome = await agent.pursue(freeform);

    // HDMI3, which only the engine asked for.
    expect(await platform.system.getInputSource()).toBe("hdmi3");
    expect(shapes(outcome)).toEqual(["tv.input.switch:verified"]);
    expect(outcome.plan.rationale).toContain("modelpilot(req-abc via openai-mini)");
    expect(telemetry[0]).toMatchObject({ mode: "enforce", status: "ok" });
  });

  it("still asks local policy before touching anything", async () => {
    // `tv.input.switch` is medium risk: it takes the screen away from whoever is
    // watching. A remote engine's plan does not change that.
    const platform = createWebAdapter();
    const declined = new Agent({
      platform, llm: { id: "s", complete: async () => ({ wantsToolCalls: false, message: { role: "assistant", content: "" } }) },
      llmPlanning: true,
      confirm: () => false,
      planner: createModelPilotPlanner({
        client: createModelPilotClient({
          baseUrl: "https://modelpilot.test", apiKey: KEY,
          fetchImpl: mockModelPilot(answer(switchToHdmi3)).fetchImpl,
        }),
        mode: "enforce",
        graph: new Agent({ platform, llm: { id: "s2", complete: async () => ({ wantsToolCalls: false, message: { role: "assistant", content: "" } }) } }).capabilities,
        world: new (await import("@hearthkit/core")).WorldModel(),
        devices: new DeviceGraph(),
      }),
    });

    const outcome = await declined.pursue(freeform);
    expect(shapes(outcome)).toEqual(["tv.input.switch:denied"]);
    expect(await platform.system.getInputSource()).not.toBe("hdmi3");
  });

  it("falls back to the local planner when ModelPilot times out, and records why", async () => {
    const { agent, platform, telemetry } = setup({ mode: "enforce", hang: true });
    await agent.pursue({ id: "input_switched", desiredState: [{ path: W.tvInput, equals: "hdmi2" }] });

    expect(await platform.system.getInputSource()).toBe("hdmi2");
    expect(telemetry[0]).toMatchObject({ status: "error", mode: "enforce" });
    expect(telemetry[0]?.fallback_reason).toMatch(/timeout/);
  });

  it("refuses instead of falling back when the host asked it to", async () => {
    const { agent, platform } = setup({ mode: "enforce", hang: true, onUnavailable: "refuse" });
    const outcome = await agent.pursue({
      id: "input_switched", desiredState: [{ path: W.tvInput, equals: "hdmi2" }],
    });
    expect(outcome.plan.steps).toEqual([]);
    expect(outcome.plan.rationale).toMatch(/configured to refuse/);
    expect(await platform.system.getInputSource()).not.toBe("hdmi2");
  });
});

describe("nothing touches the TV unless the answer holds up", () => {
  it("acts on an answer the service has not marked successful, because it never does", async () => {
    // The regression this pins: `evaluation_status` is `unverified` on every
    // completion until a verifier posts to /v1/feedback, and this planner used
    // to read that as "the answer is unusable". Enforce mode refused every
    // answer it ever received, and the mock agreed with it because the mock was
    // written from the same misreading.
    const { agent, platform, telemetry } = setup({ mode: "enforce" });
    const outcome = await agent.pursue(freeform);

    expect(telemetry[0]).toMatchObject({ status: "ok", evaluation_status: "unverified" });
    // The plan ran, and the local read-back is what decided it worked.
    expect(shapes(outcome)).toEqual(["tv.input.switch:verified"]);
    expect(await platform.system.getInputSource()).toBe("hdmi3");
  });

  it("does not act on a 200 that is not a plan", async () => {
    // A routing layer can answer with something plausible and unusable — prose,
    // a refusal, a restatement of the question. Nothing in the stack calls that
    // an error until it reaches the parser, which is the point of the parser.
    const { agent, platform, telemetry } = setup({
      mode: "enforce",
      answer: answer("Sure — which input did you want, and shall I turn it up?"),
    });
    const outcome = await agent.pursue(freeform);

    expect(outcome.plan.steps).toEqual([]);
    expect(await platform.system.getInputSource()).toBe("tv");
    expect(telemetry[0]).toMatchObject({ status: "unusable_output" });
  });

  it("does not act, and stays investigable, when the answer names no plan at all", async () => {
    const { agent, platform, telemetry } = setup({
      mode: "enforce",
      answer: answer("I'd be happy to help with your television!"),
    });
    const outcome = await agent.pursue(freeform);

    expect(outcome.plan.steps).toEqual([]);
    expect(await platform.system.getInputSource()).toBe("tv");
    // The one id that can be looked up afterwards, and the model that produced it.
    expect(outcome.plan.rationale).toContain("request=req-abc");
    expect(outcome.plan.rationale).toContain("model=openai-mini");
    expect(telemetry[0]).toMatchObject({ status: "unusable_output" });
  });

  it("does not act when the JSON is incomplete", async () => {
    const { agent, platform, telemetry } = setup({
      mode: "enforce",
      // No expected_state, no risk: two of the five required keys.
      answer: answer({ action: "set_input", target: "tv", parameters: { source: "hdmi3" } }),
    });
    const outcome = await agent.pursue(freeform);

    expect(outcome.plan.steps).toEqual([]);
    expect(await platform.system.getInputSource()).toBe("tv");
    expect(outcome.plan.rationale).toMatch(/did not validate/);
    expect(telemetry[0]).toMatchObject({ status: "unusable_output" });
  });

  it("does not act on an action this device cannot perform", async () => {
    const { agent, platform } = setup({
      mode: "enforce",
      answer: answer({
        action: "power", target: "tv", parameters: {}, expected_state: { "tv.power": "off" }, risk: "high",
      }),
    });
    const outcome = await agent.pursue(freeform);
    expect(outcome.plan.steps).toEqual([]);
    expect(outcome.plan.rejections?.[0]?.reason).toMatch(/no capability on this device performs "power"/);
    expect(await platform.system.getInputSource()).toBe("tv");
  });

  it("treats ask_user as a legitimate answer that runs nothing", async () => {
    const { agent } = setup({
      mode: "enforce",
      answer: answer({
        action: "ask_user", target: "tv", parameters: { question: "which input?" },
        expected_state: {}, risk: "low", reason: "ambiguous",
      }),
    });
    const outcome = await agent.pursue(freeform);
    expect(outcome.plan.steps).toEqual([]);
    // Not a rejection: an engine asking for a human is the system working.
    expect(outcome.plan.rejections).toBeUndefined();
  });

  it("refuses an out-of-range argument rather than clamping it", async () => {
    const { agent } = setup({
      mode: "enforce",
      answer: answer({
        action: "set_input", target: "tv", parameters: { source: "hdmi9" },
        expected_state: { "tv.input": "hdmi9" }, risk: "low",
      }),
    });
    const outcome = await agent.pursue(freeform);
    expect(outcome.plan.steps).toEqual([]);
    expect(outcome.plan.rejections?.[0]?.reason).toMatch(/must be one of/);
  });
});

describe("the local verifier has the last word", () => {
  it("reports failure and enters recovery when the TV did not do it", async () => {
    // ModelPilot said verified. The engine was right about the *plan*; the
    // television took the write and stayed where it was.
    const { agent, platform } = setup({ mode: "enforce", breakInput: true });
    const outcome = await agent.pursue(freeform);

    expect(shapes(outcome)).toEqual(["tv.input.switch:failed"]);
    expect(outcome.achieved).toBe(false);
    // The world does not believe the claim, so nothing downstream is built on it.
    expect(agent.world.value(W.tvInput)).not.toBe("hdmi3");
    expect(await platform.system.getInputSource()).not.toBe("hdmi3");
    expect(agent.describe(outcome)).toMatch(/Couldn't|can't/);
  });
});

describe("action plan parsing", () => {
  it("accepts a fenced, nested or chatty answer", () => {
    for (const wrapped of [
      switchToHdmi3,
      { output: switchToHdmi3 },
      { result: { plan: switchToHdmi3 } },
      "```json\n" + JSON.stringify(switchToHdmi3) + "\n```",
      "Sure! " + JSON.stringify(switchToHdmi3),
    ]) {
      expect(parseActionPlan(wrapped).ok, JSON.stringify(wrapped).slice(0, 40)).toBe(true);
    }
  });

  it("rejects, rather than repairs, an incomplete answer", () => {
    const result = parseActionPlan({ action: "set_input", target: "tv", parameters: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('missing "expected_state"');
      expect(result.errors).toContain('missing "risk"');
    }
  });

  it("rejects an action outside the vocabulary", () => {
    const result = parseActionPlan({
      action: "purchase", target: "tv", parameters: { sku: "x" },
      expected_state: {}, risk: "high",
    });
    expect(result.ok).toBe(false);
  });
});
