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

describe("createOpenAiCompatibleClient request mapping", () => {
  /** Captures the request body so the wire shape can be asserted. */
  function capturingClient(opts: Partial<Parameters<typeof createOpenAiCompatibleClient>[0]> = {}) {
    const seen: { url?: string; headers?: any; body?: any } = {};
    const fetchImpl = (async (url: string, init: any) => {
      seen.url = url;
      seen.headers = init.headers;
      seen.body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({
      baseUrl: "http://x/v1", model: "m", fetchImpl, ...opts,
    });
    return { client, seen };
  }

  it("maps an assistant tool call and its tool result to the OpenAI wire shape", async () => {
    const { client, seen } = capturingClient();
    await client.complete({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "volume 30" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "set_volume", args: { level: 30 } }] },
        { role: "tool", toolCallId: "c1", content: '{"ok":true}' },
      ],
      tools: [],
    });
    expect(seen.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "volume 30" },
      {
        role: "assistant",
        // The API rejects an empty string alongside tool_calls; it must be null.
        content: null,
        tool_calls: [{
          id: "c1",
          type: "function",
          function: { name: "set_volume", arguments: '{"level":30}' },
        }],
      },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
    ]);
  });

  it("keeps assistant text that accompanies a tool call", async () => {
    const { client, seen } = capturingClient();
    await client.complete({
      messages: [{ role: "assistant", content: "Setting it now.", toolCalls: [{ id: "c2", name: "set_mute", args: { mute: true } }] }],
      tools: [],
    });
    expect(seen.body.messages[0].content).toBe("Setting it now.");
  });

  it("translates tool specs into JSON-schema function definitions", async () => {
    const { client, seen } = capturingClient();
    await client.complete({
      messages: [],
      tools: [{
        name: "set_input_source",
        description: "Switch input",
        confirm: true,
        parameters: {
          source: { type: "string", description: "Input id", required: true, enum: ["hdmi1", "tv"] },
          force: { type: "boolean", description: "Skip checks" },
        },
      }],
    });
    expect(seen.body.tools).toEqual([{
      type: "function",
      function: {
        name: "set_input_source",
        description: "Switch input",
        parameters: {
          type: "object",
          properties: {
            // No `required` in here: our ToolParameter carries one as a
            // convenience, JSON Schema does not. See the test below.
            source: { type: "string", description: "Input id", enum: ["hdmi1", "tv"] },
            force: { type: "boolean", description: "Skip checks" },
          },
          required: ["source"],   // only the required ones, derived from the spec
        },
      },
    }]);
    expect(seen.body.tool_choice).toBe("auto");
  });

  it("posts to /chat/completions, sends the api key only when set, and flags streaming", async () => {
    const plain = capturingClient();
    await plain.client.complete({ messages: [], tools: [] });
    expect(plain.seen.url).toBe("http://x/v1/chat/completions");
    expect(plain.seen.headers.authorization).toBeUndefined();
    expect(plain.seen.body).toMatchObject({ model: "m", stream: false, temperature: 0.2, max_tokens: 512 });

    const keyed = capturingClient({ apiKey: "sk-test" });
    await keyed.client.complete({ messages: [], tools: [], temperature: 0.9, maxTokens: 64 });
    expect(keyed.seen.headers.authorization).toBe("Bearer sk-test");
    expect(keyed.seen.body).toMatchObject({ temperature: 0.9, max_tokens: 64 });
  });

  it("parses tool calls out of a non-streaming response", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: "c9", type: "function", function: { name: "launch_app", arguments: '{"appId":"netflix"}' } }],
          },
        }],
      }),
    })) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const r = await client.complete({ messages: [], tools: [] });
    expect(r.wantsToolCalls).toBe(true);
    expect(r.message.toolCalls?.[0]).toMatchObject({ id: "c9", name: "launch_app", args: { appId: "netflix" } });
    expect(r.message.content).toBe("");
  });

  it("treats unparseable tool arguments as empty args instead of throwing", async () => {
    // Small local models do emit malformed JSON; the agent should get a chance
    // to recover from a tool-validation error rather than crash the turn.
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "set_volume", arguments: "{level: thirty" } }] } }],
      }),
    })) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const r = await client.complete({ messages: [], tools: [] });
    expect(r.message.toolCalls?.[0]?.args).toEqual({});
  });

  describe("the properties we put on the wire must be real JSON Schema", () => {
  /**
   * `ToolParameter` is JSON-schema-*ish*: it carries `required: boolean` per
   * property because that is the convenient way to declare a tool. JSON Schema
   * spells requiredness as an array of names on the parent object, and reserves
   * `required` *inside* a property for that property's own nested object — so a
   * boolean there is not a harmless extra key, it is the wrong type for a real
   * one.
   *
   * OpenAI ignores it, which is why this shipped. Ollama is strictly typed and
   * refused every request:
   *
   *   400 json: cannot unmarshal bool into Go struct field
   *   ToolFunctionParameters.tools.function.parameters.properties.required
   *   of type []string
   *
   * Not one bad turn — the tool list goes out with every request, so the agent
   * could not call a single tool. Found the first time it was pointed at a
   * local model. The suite passed throughout: the offline client never sees a
   * schema, so nothing offline could have caught it.
   */
  it("never emits a boolean `required` inside a property", async () => {
    const { client, seen } = capturingClient();
    await client.complete({
      messages: [],
      tools: [{
        name: "set_volume",
        description: "Set volume",
        parameters: { level: { type: "number", description: "0-100", required: true } },
      }],
    });
    const props = (seen.body.tools as any)[0].function.parameters.properties;
    expect(props.level).not.toHaveProperty("required");
    // …and the requiredness still reaches the model, in the place it belongs.
    expect((seen.body.tools as any)[0].function.parameters.required).toEqual(["level"]);
  });

  it("passes through only keys JSON Schema defines", async () => {
    // An allow-list, not a delete-one-key: whatever we add to ToolParameter
    // next is ours too, and does not belong on the wire either.
    const { client, seen } = capturingClient();
    await client.complete({
      messages: [],
      tools: [{
        name: "t",
        description: "d",
        parameters: {
          a: { type: "string", description: "x", required: true, enum: ["p"], mine: 1 } as never,
        },
      }],
    });
    const props = (seen.body.tools as any)[0].function.parameters.properties;
    expect(Object.keys(props.a).sort()).toEqual(["description", "enum", "type"]);
  });
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

