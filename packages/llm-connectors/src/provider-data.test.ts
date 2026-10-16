import { describe, expect, it } from "vitest";
import type { ChatMessage, CompletionRequest } from "@hearthkit/core";
import { createOpenAiCompatibleClient } from "./openai-compatible.js";

/**
 * A provider can attach something to a tool call that only it understands — for Gemini, a signature the next turn must
 * present, or the provider refuses the tool result. The hosted ModelPilot carries it as `provider_metadata`. Hearth
 * does not read it; what it must do is not lose it. These tests give a fake service a call with extras in each place one
 * might live and check they come back on the second request exactly as received — non-streamed and streamed.
 */
const SIGNED = { provider: "google", thought_signature: "c2lnbmVkLWJ5LWdlbWluaQ==" };
const REQ: CompletionRequest = {
  messages: [{ role: "user", content: "Check the device." }],
  tools: [{ name: "get_device_status", description: "d", parameters: { device: { type: "string", description: "which", required: true } } } as never],
};

function service(mode: "plain" | "sse") {
  const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const second = body.messages.some((m: { role: string }) => m.role === "tool");
    if (second) {
      return mode === "sse"
        ? new Response('data: {"choices":[{"delta":{"content":"Online."}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
        : Response.json({ choices: [{ message: { role: "assistant", content: "Online." } }] });
    }
    if (mode === "sse") {
      const chunks = [
        { choices: [{ delta: { role: "assistant", provider_metadata: { turn: "t1" }, tool_calls: [{ index: 0, id: "call_9", type: "function", provider_metadata: SIGNED, function: { name: "get_device_status", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"device":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hearth"}', extra_in_function: 7 } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant", content: null, provider_metadata: { turn: "t1" },
          tool_calls: [{ id: "call_9", type: "function", provider_metadata: SIGNED, function: { name: "get_device_status", arguments: '{"device":"hearth"}', extra_in_function: 7 } }],
        },
      }],
    });
  }) as unknown as typeof fetch;
  return { bodies, client: createOpenAiCompatibleClient({ baseUrl: "http://x/v1", model: "gemini-flash", apiKey: "k", retries: 0, fetchImpl }) };
}

async function roundTrip(mode: "plain" | "sse") {
  const { client, bodies } = service(mode);
  const ask = (req: CompletionRequest) => (mode === "sse" ? client.completeStream!(req, {}) : client.complete(req));
  const first = await ask(REQ);
  const second = await ask({ ...REQ, messages: [...REQ.messages, first.message, { role: "tool", toolCallId: "call_9", content: '{"online":true}' } as ChatMessage] });
  return { first, second, sent: bodies[1]!.messages };
}

for (const mode of ["plain", "sse"] as const) {
  describe(`provider data on a tool call, ${mode === "sse" ? "streamed" : "not streamed"}`, () => {
    it("is kept as received, and the call still reads as the same call", async () => {
      const { first } = await roundTrip(mode);
      expect(first.wantsToolCalls).toBe(true);
      expect(first.message.toolCalls?.[0]).toMatchObject({
        id: "call_9", name: "get_device_status", args: { device: "hearth" },
        providerData: { provider_metadata: SIGNED, ...(mode === "sse" ? {} : {}) },
      });
    });

    it("goes back on the second request untouched — on the call, inside its function object, and on the message", async () => {
      const { sent, second } = await roundTrip(mode);
      const assistant = sent.find((m) => m.role === "assistant") as Record<string, any>;
      expect(assistant.provider_metadata).toEqual({ turn: "t1" });
      expect(assistant.tool_calls[0]).toMatchObject({ id: "call_9", type: "function", provider_metadata: SIGNED });
      expect(assistant.tool_calls[0].function).toMatchObject({ name: "get_device_status", arguments: '{"device":"hearth"}', extra_in_function: 7 });
      expect(sent.find((m) => m.role === "tool")).toMatchObject({ tool_call_id: "call_9" });
      expect(second.message.content).toBe("Online.");
    });
  });
}

describe("a service that attaches nothing", () => {
  it("is not given extra fields: the request is the plain OpenAI shape", async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }] } }] });
    }) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({ baseUrl: "http://x/v1", model: "m", retries: 0, fetchImpl });
    const first = await client.complete(REQ);
    expect(first.message.providerData).toBeUndefined();
    expect(first.message.toolCalls?.[0]?.providerData).toBeUndefined();
    await client.complete({ ...REQ, messages: [...REQ.messages, first.message, { role: "tool", toolCallId: "c", content: "{}" }] });
    const assistant = bodies[1]!.messages.find((m) => m.role === "assistant") as Record<string, any>;
    expect(Object.keys(assistant).sort()).toEqual(["content", "role", "tool_calls"]);
    expect(Object.keys(assistant.tool_calls[0]).sort()).toEqual(["function", "id", "type"]);
  });
});
