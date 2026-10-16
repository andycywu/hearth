import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkExitCode, formatChecks, runChecks } from "./modelpilot-check.js";
import { runModelPilotCheck } from "./modelpilot-targets.js";

/**
 * A ModelPilot that behaves like the hosted one did on 2026-10-16 — OpenAI-shaped completions, SSE, tool calls —
 * with switches for the ways a real one failed: a provider that cannot stream (422), tool-call arguments that arrive
 * under the wrong index, a catalogue that leaks the key into an error. The check is run against it through real
 * sockets, because what is being tested is whether this code can *read* what a service sends.
 */
const KEY = "mp_live_test-secret-key";
let server: Server | undefined;
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });

interface Fake { streaming?: boolean; wrongIndex?: boolean; leakKey?: boolean; toolOnce?: boolean }

async function fake(o: Fake = {}): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const read = (req: IncomingMessage): Promise<string> => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const sse = async (res: ServerResponse, chunks: unknown[]) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of chunks) { res.write(`data: ${JSON.stringify(c)}\n\n`); await new Promise((r) => setTimeout(r, 4)); }
    res.end("data: [DONE]\n\n");
  };
  const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

  server = createServer(async (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: "Invalid API key" } });
    if (req.url === "/v1/models") {
      if (o.leakKey) return json(res, 500, { error: { message: `upstream rejected ${KEY}` } });
      return json(res, 200, { data: [{ id: "openai-mini", availability: { routable: true } }, { id: "claude-sonnet", availability: { routable: true } }] });
    }
    const body = JSON.parse(await read(req));
    const hasToolResult = body.messages.some((m: { role: string }) => m.role === "tool");
    const wantsTool = Array.isArray(body.tools) && body.tools.length > 0 && !hasToolResult;
    const model = body.model === "auto" ? "openai-mini" : body.model;
    const mp = { request_id: "req-1", selected_model: model, actual_cost: 0.00001 };

    if (body.stream) {
      if (o.streaming === false) return json(res, 422, { error: { message: `Model '${model}' does not support streaming yet.`, code: "streaming_provider_not_supported" } });
      if (wantsTool) {
        const at = (i: number) => (o.wrongIndex ? i : 0);
        return sse(res, [
          delta({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_device_status", arguments: "" } }] }),
          delta({ tool_calls: [{ index: at(0), function: { arguments: '{"device":' } }] }),
          delta({ tool_calls: [{ index: at(1), function: { arguments: '"hearth"}' } }] }),
          delta({}, "tool_calls"),
        ]);
      }
      const text = hasToolResult ? ["Hearth is ", "online, ", "48.2 C"] : Array.from({ length: 30 }, (_, i) => `${i + 1}, `);
      return sse(res, [...text.map((t) => delta({ content: t })), delta({}, "stop"), { choices: [], usage: { total_tokens: 12 } }]);
    }

    if (wantsTool) {
      return json(res, 200, { choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_device_status", arguments: '{"device":"hearth"}' } }] }, finish_reason: "tool_calls" }], usage: { total_tokens: 9 }, modelpilot: mp });
    }
    const content = hasToolResult ? "Hearth is online, CPU 48.2 C" : /exactly: Hearth connected/.test(JSON.stringify(body.messages)) ? "Hearth connected" : "ok";
    return json(res, 200, { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { total_tokens: 7 }, modelpilot: mp });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, seen };
}

describe("hearth modelpilot check", () => {
  it("every row verified against a service that does what the hosted one did — including Hearth's own client doing the whole tool loop, streamed and not", async () => {
    const { url } = await fake();
    const rows = await runChecks({ baseUrl: url, apiKey: KEY, reasoningEffort: "low", runs: 3 });
    expect(rows.map((r) => `${r.verdict} ${r.name}`)).toEqual([
      "verified 1 /v1/models", "verified 2 chat, not streamed", "verified 3 chat, streamed (SSE)", "verified 4 tool call, first turn",
      "verified 5 tool result, second turn", "verified 6 tool call, streamed",
      "verified 7 Hearth's client: tool loop, not streamed", "verified 8 Hearth's client: tool loop, streamed",
      "verified 9 cancel a stream half way, then ask again", "verified 10 3× chat, not streamed", "verified 11 3× chat, streamed",
    ]);
    expect(rows.find((r) => r.name.startsWith("6"))?.detail).toContain('merged by index into {"device":"hearth"}');
    expect(rows.find((r) => r.name.startsWith("3"))?.detail).toContain("30 text chunks");
    expect(checkExitCode(rows)).toBe(0);
  });

  it("a provider that cannot stream fails exactly the streamed rows, with the service's own reason, and the rest still pass", async () => {
    const { url } = await fake({ streaming: false });
    const rows = await runChecks({ baseUrl: url, apiKey: KEY, model: "claude-sonnet" });
    const by = (n: string) => rows.find((r) => r.name.startsWith(n))!;
    expect(by("3").verdict).toBe("failed");
    expect(by("3").detail).toContain("does not support streaming");
    expect(by("6").verdict).toBe("failed");
    expect(by("8").verdict).toBe("failed");
    expect(by("9").verdict).toBe("unverified");                       // nothing to cancel is not a pass
    for (const n of ["1", "2", "4", "5", "7"]) expect(by(n).verdict, n).toBe("verified");
    expect(checkExitCode(rows)).toBe(1);
  });

  it("tool-call arguments that arrive under different indexes are not merged into JSON, and that is a failure, not a guess", async () => {
    const { url } = await fake({ wrongIndex: true });
    const rows = await runChecks({ baseUrl: url, apiKey: KEY });
    expect(rows.find((r) => r.name.startsWith("6"))).toMatchObject({ verdict: "failed", detail: expect.stringContaining("merged arguments are not the expected JSON") });
  });

  it("`auto` is judged as \"any routable model\", not looked up as if it were a catalogue entry", async () => {
    const { url } = await fake();
    const rows = await runChecks({ baseUrl: url, apiKey: KEY, model: "auto" });
    expect(rows[0]).toMatchObject({ verdict: "verified", detail: expect.stringContaining("auto can route to") });
    expect(rows[1]?.verdict).toBe("verified");
  });

  it("the key never reaches the output, even when the service puts it in an error body", async () => {
    const { url } = await fake({ leakKey: true });
    const rows = await runChecks({ baseUrl: url, apiKey: KEY });
    expect(rows[0]).toMatchObject({ verdict: "failed" });
    expect(formatChecks(rows, "official", url)).not.toContain(KEY);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("an unreachable service fails every row it touches with the reason, and does not hang", async () => {
    const rows = await runChecks({ baseUrl: "http://127.0.0.1:9", apiKey: KEY, timeoutMs: 2000 });
    expect(rows.every((r) => r.verdict === "failed" || r.verdict === "unverified")).toBe(true);
    expect(rows[0]?.detail).toMatch(/ECONNREFUSED|fetch failed|refused/i);
  });

  it("the subcommand needs a key for the target it is aimed at, and says which variable, sending nothing", async () => {
    let out = "";
    expect(await runModelPilotCheck({}, { MODELPILOT_LOCAL_API_KEY: "x" }, { out: (t) => { out += t; } })).toBe(2);
    expect(out).toContain("MODELPILOT_OFFICIAL_API_KEY");
  });
});
