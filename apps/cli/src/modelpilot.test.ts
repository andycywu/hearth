import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { Agent, WorldModel } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createScriptedClient } from "@hearthkit/llm-connectors";
import { PRODUCTION_BASE_URL } from "@hearthkit/modelpilot";
import { connectModelPilot, routerChatClient } from "./modelpilot.js";
import { answer } from "./voice-loop.js";

const memory = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); }, remove: async (k: string) => { m.delete(k); }, keys: async () => [...m.keys()] };
};

describe("finding ModelPilot from the environment", () => {
  it("does nothing, and builds no client, without a key — a Pi with no credential never reaches for the cloud", async () => {
    expect(await connectModelPilot({}, memory(), { explicitLlm: false })).toBeUndefined();
    expect(await connectModelPilot({ MODELPILOT_MODE: "enforce" }, memory(), { explicitLlm: false })).toBeUndefined();
  });

  it("does nothing when switched off, even with a key", async () => {
    expect(await connectModelPilot({ MODELPILOT_API_KEY: "k", MODELPILOT_MODE: "off" }, memory(), { explicitLlm: false })).toBeUndefined();
  });

  it("with a key: shadow by default, production service, conversation through the router with model auto", async () => {
    const mp = await connectModelPilot({ MODELPILOT_API_KEY: "mp-key" }, memory(), { explicitLlm: false });
    expect(mp?.config).toMatchObject({ mode: "shadow", baseUrl: PRODUCTION_BASE_URL, apiKey: "mp-key", source: "default" });
    expect(mp?.chat).toEqual({ baseUrl: `${PRODUCTION_BASE_URL}/v1`, model: "auto", apiKey: "mp-key" });
  });

  it("reads the mode, the service and the model from the environment", async () => {
    const mp = await connectModelPilot({
      MODELPILOT_API_KEY: "k", MODELPILOT_MODE: "enforce", MODELPILOT_BASE_URL: "http://lan:8090/", MODELPILOT_MODEL: "cheap-fast",
    }, memory(), { explicitLlm: false });
    expect(mp?.config).toMatchObject({ mode: "enforce", baseUrl: "http://lan:8090", source: "env" });
    expect(mp?.chat).toEqual({ baseUrl: "http://lan:8090/v1", model: "cheap-fast", apiKey: "k" });
  });

  it("leaves conversation to --llm when one is given, or when told to", async () => {
    expect((await connectModelPilot({ MODELPILOT_API_KEY: "k" }, memory(), { explicitLlm: true }))?.chat).toBeUndefined();
    expect((await connectModelPilot({ MODELPILOT_API_KEY: "k", MODELPILOT_CHAT: "off" }, memory(), { explicitLlm: false }))?.chat).toBeUndefined();
  });

  it("still plans in those cases — conversation and planning are separate switches", async () => {
    const mp = await connectModelPilot({ MODELPILOT_API_KEY: "k", MODELPILOT_CHAT: "off" }, memory(), { explicitLlm: false });
    expect(mp?.wiring.factory).toBeTypeOf("function");
  });
});

/** A ModelPilot that answers every completion with prose and records what it was asked. */
async function fakeModelPilot(): Promise<{ server: Server; url: string; seen: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> }> {
  const seen: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/feedback") return void res.end(JSON.stringify({ ok: true }));
      res.end(JSON.stringify({
        id: "req_1", model: "mock-small", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "It should be sunny tomorrow." } }],
        modelpilot: { request_id: "req_1", selected_model: "mock-small" },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

describe("a Pi's agent with ModelPilot behind it", () => {
  async function agentVia(url: string) {
    const mp = await connectModelPilot({ MODELPILOT_API_KEY: "mp-secret-key", MODELPILOT_BASE_URL: url }, memory(), { explicitLlm: false });
    const platform = createWebAdapter();
    await platform.init();
    const agent = new Agent({
      platform, world: new WorldModel(),
      llm: mp?.chat ? routerChatClient(mp.chat) : createScriptedClient(),
      ...(mp ? { planner: mp.wiring.factory, llmPlanning: true } : {}),
      confirm: async () => true,
    });
    return { agent, mp };
  }

  it("answers a question through the router, with the key, asking for model auto", async () => {
    const mp = await fakeModelPilot();
    const { agent } = await agentVia(mp.url);
    const reply = await answer(agent, "will it rain tomorrow");
    expect(reply).toBe("It should be sunny tomorrow.");
    const chat = mp.seen.filter((r) => r.path === "/v1/chat/completions");
    expect(chat.length).toBeGreaterThanOrEqual(1);
    expect(chat.every((r) => r.auth === "Bearer mp-secret-key")).toBe(true);
    expect(chat.at(-1)!.body.model).toBe("auto");
    mp.server.close();
  });

  it("does not let a ModelPilot that answers in prose turn a question into 'nothing to do'", async () => {
    const mp = await fakeModelPilot();
    const { agent } = await agentVia(mp.url);
    expect(await answer(agent, "what is the capital of France")).not.toMatch(/nothing to do|nothing runnable/i);
    mp.server.close();
  });

  it("still does what it can do locally, and reads it back — the router is never what says it worked", async () => {
    const mp = await fakeModelPilot();
    const { agent } = await agentVia(mp.url);
    const before = await agent.opts.platform.system!.getVolume();
    const reply = await answer(agent, "turn it down");
    expect(reply).toMatch(/volume|Done|quieter/i);
    expect(await agent.opts.platform.system!.getVolume()).toBeLessThan(before);
    mp.server.close();
  });
});
