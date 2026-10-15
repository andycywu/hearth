import { describe, expect, it } from "vitest";
import type { Goal, Plan, PlannerContext } from "@hearthkit/core";
import { PRODUCTION_BASE_URL, type ModelPilotPlanner, type ShadowRecord } from "@hearthkit/modelpilot";
import { parseArgs } from "./args.js";
import { connectModelPilot } from "./modelpilot.js";
import {
  envForTarget, formatStatus, LOCAL_BASE_URL, probeTarget, resolveTarget, runModelPilotStatus, withComparison, type CompareRecord,
} from "./modelpilot-targets.js";

const memory = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); }, remove: async (k: string) => { m.delete(k); }, keys: async () => [...m.keys()] };
};

const both = {
  MODELPILOT_OFFICIAL_API_KEY: "official-secret", MODELPILOT_LOCAL_API_KEY: "local-secret",
};

describe("named targets", () => {
  it("official defaults to the hosted service and local to this box, each with its own key", () => {
    expect(resolveTarget(both, "official")).toMatchObject({ baseUrl: PRODUCTION_BASE_URL, apiKey: "official-secret" });
    expect(resolveTarget(both, "local")).toMatchObject({ baseUrl: LOCAL_BASE_URL, apiKey: "local-secret" });
    expect(resolveTarget({ MODELPILOT_LOCAL_BASE_URL: "http://nas:8000/" }, "local").baseUrl).toBe("http://nas:8000");
  });

  it("never lends one target's key to another, nor leaves the unnamed key behind", () => {
    const env = envForTarget({ ...both, MODELPILOT_API_KEY: "unnamed" }, resolveTarget(both, "local"));
    expect(env.MODELPILOT_API_KEY).toBe("local-secret");
    const none = envForTarget({ MODELPILOT_API_KEY: "unnamed", MODELPILOT_OFFICIAL_API_KEY: "o" }, resolveTarget({}, "local"));
    expect(none.MODELPILOT_API_KEY).toBeUndefined();
  });

  it("a named target without its key is off, says which variable is missing, and sends nothing", async () => {
    const notes: string[] = [];
    const mp = await connectModelPilot({ MODELPILOT_LOCAL_API_KEY: "l" }, memory(), { explicitLlm: false, target: "official", note: (m) => notes.push(m) });
    expect(mp).toBeUndefined();
    expect(notes.join()).toContain("MODELPILOT_OFFICIAL_API_KEY");
  });

  it("--modelpilot picks the service, URL and conversation endpoint together", async () => {
    const mp = await connectModelPilot(both, memory(), { explicitLlm: false, target: "local" });
    expect(mp).toMatchObject({ target: "local", config: { baseUrl: LOCAL_BASE_URL, apiKey: "local-secret" } });
    expect(mp?.chat).toEqual({ baseUrl: `${LOCAL_BASE_URL}/v1`, model: "auto", apiKey: "local-secret" });
    expect((await connectModelPilot(both, memory(), { explicitLlm: false, target: "official" }))?.config.baseUrl).toBe(PRODUCTION_BASE_URL);
  });

  it("MODELPILOT_TARGET is the same switch; --modelpilot off and a typo both leave ModelPilot out", async () => {
    expect((await connectModelPilot({ ...both, MODELPILOT_TARGET: "local" }, memory(), { explicitLlm: false }))?.target).toBe("local");
    expect(await connectModelPilot({ ...both, MODELPILOT_TARGET: "local" }, memory(), { explicitLlm: false, target: "off" })).toBeUndefined();
    const notes: string[] = [];
    expect(await connectModelPilot(both, memory(), { explicitLlm: false, target: "oficial", note: (m) => notes.push(m) })).toBeUndefined();
    expect(notes.join()).toContain("unknown target");
  });

  it("the unnamed MODELPILOT_API_KEY still works exactly as before", async () => {
    const mp = await connectModelPilot({ MODELPILOT_API_KEY: "k" }, memory(), { explicitLlm: false });
    expect(mp?.target).toBeUndefined();
    expect(mp?.config.baseUrl).toBe(PRODUCTION_BASE_URL);
  });

  it("--compare needs a named target and a key for the other one, and says so when it has neither", async () => {
    const notes: string[] = [];
    const note = (m: string) => notes.push(m);
    expect((await connectModelPilot({ MODELPILOT_API_KEY: "k" }, memory(), { explicitLlm: false, compare: true, note }))?.comparing).toBeUndefined();
    expect((await connectModelPilot({ MODELPILOT_LOCAL_API_KEY: "l" }, memory(), { explicitLlm: false, target: "local", compare: true, note }))?.comparing).toBeUndefined();
    expect((await connectModelPilot(both, memory(), { explicitLlm: false, target: "local", compare: true, note }))?.comparing).toBe("official");
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain("MODELPILOT_OFFICIAL_API_KEY");
  });
});

describe("hearth modelpilot status", () => {
  const reply = (table: Record<string, number>): typeof fetch =>
    (async (url: string | URL | Request) => new Response("{}", { status: table[new URL(String(url)).pathname] ?? 404 })) as typeof fetch;

  it("verified only when the service is there and accepts the key", async () => {
    const t = resolveTarget(both, "local");
    expect(await probeTarget(t, { fetchImpl: reply({ "/health": 200, "/v1/models": 200 }) })).toMatchObject({ verdict: "verified" });
    expect(await probeTarget(t, { fetchImpl: reply({ "/health": 200, "/v1/models": 401 }) })).toMatchObject({ verdict: "failed", detail: expect.stringContaining("key rejected") });
  });

  it("a 404 from the models route is unverified, not a pass — it says nothing about the key", async () => {
    expect(await probeTarget(resolveTarget(both, "official"), { fetchImpl: reply({}) })).toMatchObject({ verdict: "unverified" });
  });

  it("an unreachable service is failed, with the reason; no key is unconfigured and no request is made", async () => {
    const refused = (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as unknown as typeof fetch;
    expect(await probeTarget(resolveTarget(both, "local"), { fetchImpl: refused })).toMatchObject({ verdict: "failed", detail: "unreachable (ECONNREFUSED)" });
    let calls = 0;
    const counting = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await probeTarget(resolveTarget({}, "official"), { fetchImpl: counting })).toMatchObject({ verdict: "unconfigured" });
    expect(calls).toBe(0);
  });

  it("sends the key as a bearer header and prints neither key", async () => {
    const seen: Array<string | null> = [];
    const spy = (async (_u: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers).get("authorization")); return new Response("{}"); }) as unknown as typeof fetch;
    let out = "";
    const code = await runModelPilotStatus(both, { out: (t) => { out += t; } }, { fetchImpl: spy });
    expect(code).toBe(0);
    expect(seen).toContain("Bearer official-secret");
    expect(seen).toContain("Bearer local-secret");
    expect(out).not.toContain("secret");
    expect(out).toContain("verified");
  });

  it("with no key anywhere, says where to put them and exits 0 — nothing is wrong, nothing is configured", async () => {
    let out = "";
    expect(await runModelPilotStatus({}, { out: (t) => { out += t; } })).toBe(0);
    expect(out).toContain("MODELPILOT_OFFICIAL_API_KEY");
    expect(formatStatus([])).toContain("ModelPilot targets");
  });

  it("is a subcommand only as exactly `modelpilot status`; flags parse and are validated", () => {
    expect(parseArgs(["modelpilot", "status"]).modelpilotStatus).toBe(true);
    expect(parseArgs(["modelpilot", "is", "slow"])).toMatchObject({ modelpilotStatus: false, commands: ["modelpilot", "is", "slow"] });
    expect(parseArgs(["--modelpilot", "local", "--compare", "hi"])).toMatchObject({ modelpilot: "local", compare: true, commands: ["hi"] });
    expect(parseArgs(["--modelpilot=cloud"]).errors[0]).toContain("official, local or off");
  });
});

describe("--compare", () => {
  const goal = { id: "g1", desiredState: [], intent: "dim the lights and play jazz" } as unknown as Goal;
  const plan = { id: "p", goal, steps: [], createdAt: 0 } as unknown as Plan;
  const record = (steps: string[], model?: string): ShadowRecord =>
    ({ workflowId: "w", agreement: "differs", localSteps: [], remoteSteps: steps, ...(model ? { selectedModel: model } : {}) }) as unknown as ShadowRecord;
  const planner = (answer: ShadowRecord | undefined, throwing = false): ModelPilotPlanner => {
    const shadow: ShadowRecord[] = [];
    return {
      shadow,
      report: async () => {},
      async plan() { if (throwing) throw new Error("boom"); if (answer) shadow.push(answer); return plan; },
    };
  };
  const wire = (p: ModelPilotPlanner) => ({ factory: (_c: PlannerContext) => p, report: async () => {} });
  const ctx = {} as PlannerContext;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("returns the primary's plan untouched and logs how the other one differed", async () => {
    const logged: CompareRecord[] = [];
    const c = withComparison(wire(planner(record(["a", "b"], "m-1"))), wire(planner(record(["a"], "m-2"))), { primary: "local", other: "official" }, (r) => logged.push(r));
    expect(await c.factory(ctx).plan(goal)).toBe(plan);
    await settle();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      primary: { target: "local", steps: ["a", "b"], model: "m-1" }, other: { target: "official", steps: ["a"], model: "m-2" },
      summary: "local and official planned differently",
    });
  });

  it("says when both agree", async () => {
    const logged: CompareRecord[] = [];
    const same = withComparison(wire(planner(record(["a"]))), wire(planner(record(["a"]))), { primary: "official", other: "local" }, (r) => logged.push(r));
    await same.factory(ctx).plan(goal); await settle();
    expect(logged[0]?.summary).toBe("same plan from official and local");
  });

  // Both live runs of 2026-10-15 read a missing record as "nobody was asked" — over a 502, then over a mock model
  // whose answer was unusable. A call that fails or is unusable records nothing, exactly as no call does.
  it("when the other side recorded nothing, says that — not that the local planner closed the goal", async () => {
    const logged: CompareRecord[] = [];
    const c = withComparison(wire(planner(record(["a"], "m-1"))), wire(planner(undefined)), { primary: "official", other: "local" }, (r) => logged.push(r));
    await c.factory(ctx).plan(goal); await settle();
    expect(logged[0]?.summary).toBe("official suggested a plan; local gave no usable suggestion (see its ☁ line above)");
    expect(logged[0]).toMatchObject({ primary: { model: "m-1" }, other: { agreement: "no-suggestion" } });
  });

  it("when neither side recorded anything, does not pretend to know why", async () => {
    const logged: CompareRecord[] = [];
    const c = withComparison(wire(planner(undefined)), wire(planner(undefined)), { primary: "official", other: "local" }, (r) => logged.push(r));
    await c.factory(ctx).plan(goal); await settle();
    expect(logged[0]?.summary).toContain("neither side recorded a suggestion");
    expect(logged[0]?.summary).toContain("or both calls failed");
  });

  it("a second service that throws costs a log line and never the primary's plan", async () => {
    const logged: CompareRecord[] = [];
    const c = withComparison(wire(planner(record(["a"]))), wire(planner(undefined, true)), { primary: "local", other: "official" }, (r) => logged.push(r));
    expect(await c.factory(ctx).plan(goal)).toBe(plan);
    await settle();
    expect(logged[0]?.summary).toContain("could not be compared: boom");
  });
});
