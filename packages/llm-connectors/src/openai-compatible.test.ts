import { describe, it, expect } from "vitest";
import { StreamAccumulator, createOpenAiCompatibleClient } from "./openai-compatible.js";

describe("StreamAccumulator", () => {
  it("accumulates content deltas and reports them via handler", () => {
    const chunks: string[] = [];
    const acc = new StreamAccumulator({ onContentDelta: (d) => chunks.push(d) });
    acc.pushEvent('data: {"choices":[{"delta":{"content":"Vol"}}]}');
    acc.pushEvent('data: {"choices":[{"delta":{"content":"ume set"}}]}');
    acc.pushEvent("data: [DONE]");
    const r = acc.result();
    expect(chunks).toEqual(["Vol", "ume set"]);
    expect(r.message.content).toBe("Volume set");
    expect(r.wantsToolCalls).toBe(false);
  });

  it("assembles a tool call split across chunks", () => {
    const acc = new StreamAccumulator();
    acc.pushEvent('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"set_volume","arguments":"{\\"lev"}}]}}]}');
    acc.pushEvent('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"el\\":30}"}}]}}]}');
    acc.pushEvent("data: [DONE]");
    const r = acc.result();
    expect(r.wantsToolCalls).toBe(true);
    expect(r.message.toolCalls?.[0]).toMatchObject({ id: "c1", name: "set_volume", args: { level: 30 } });
  });
});

describe("createOpenAiCompatibleClient retry", () => {
  it("retries transient 500s then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 500, text: async () => "boom" };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "hi" } }] }),
      };
    }) as unknown as typeof fetch;

    const client = createOpenAiCompatibleClient({
      baseUrl: "http://x/v1", model: "m", fetchImpl, retries: 2, retryDelayMs: 1,
    });
    const r = await client.complete({ messages: [], tools: [] });
    expect(calls).toBe(3);
    expect(r.message.content).toBe("hi");
  });

  it("gives up after exhausting retries", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return { ok: false, status: 503, text: async () => "down" }; }) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({
      baseUrl: "http://x/v1", model: "m", fetchImpl, retries: 1, retryDelayMs: 1,
    });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(2); // initial + 1 retry
  });
});

describe("createOpenAiCompatibleClient.completeStream", () => {
  it("streams over a mocked SSE response", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl = (async () => ({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
    })) as unknown as typeof fetch;

    const client = createOpenAiCompatibleClient({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const deltas: string[] = [];
    const r = await client.completeStream!(
      { messages: [], tools: [] },
      { onContentDelta: (d) => deltas.push(d) },
    );
    expect(deltas.join("")).toBe("Hi there");
    expect(r.message.content).toBe("Hi there");
  });
});
