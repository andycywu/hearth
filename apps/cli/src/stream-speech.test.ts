import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";
import { configAsEnv } from "./config.js";
import { routerChatClient } from "./modelpilot.js";

/**
 * `--stream-speech` asks the router for a streamed reply and speaks it as it arrives. The router may pick a model that
 * cannot stream — `claude-sonnet` and `gemini-flash` answer `422 streaming_provider_not_supported` on the hosted
 * service — so the client falls back to the same request in one piece, once, and remembers.
 */
const CHAT = { baseUrl: "http://router/v1", model: "auto", apiKey: "k" };
const REQ = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const refusal = () => Response.json({ error: { message: "Model 'claude-sonnet' does not support streaming yet.", code: "streaming_provider_not_supported" } }, { status: 422 });
const plain = (text: string) => Response.json({ choices: [{ message: { role: "assistant", content: text } }] });

function fake(script: Array<(body: { stream?: boolean }) => Response>) {
  const calls: Array<{ stream: boolean | undefined }> = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ stream: body.stream });
    return script[Math.min(calls.length - 1, script.length - 1)]!(body);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("a router chat client that streams when it can", () => {
  it("streams when the model streams, and hands the deltas to the caller", async () => {
    const { calls, fetchImpl } = fake([() => sse("Hello")]);
    const client = routerChatClient(CHAT, { stream: true, fetchImpl });
    const seen: string[] = [];
    const result = await client.completeStream!(REQ, { onContentDelta: (d) => seen.push(d) });
    expect(seen).toEqual(["Hello"]);
    expect(result.message.content).toBe("Hello");
    expect(calls).toEqual([{ stream: true }]);
  });

  it("when the router picked a model that cannot stream, says the same thing in one piece — and does not ask again for ten minutes", async () => {
    let clock = 0;
    const { calls, fetchImpl } = fake([refusal, () => plain("whole answer"), () => plain("again"), () => sse("streams again")]);
    const client = routerChatClient(CHAT, { stream: true, fetchImpl, now: () => clock });

    const first = await client.completeStream!(REQ, {});
    expect(first.message.content).toBe("whole answer");
    expect(calls).toEqual([{ stream: true }, { stream: false }]);      // refused once, then the same request unstreamed

    const second = await client.completeStream!(REQ, {});
    expect(second.message.content).toBe("again");
    expect(calls.at(-1)).toEqual({ stream: false });                   // no wasted round trip to hear the same refusal
    expect(calls).toHaveLength(3);

    clock += 11 * 60_000;                                              // the router may pick differently by now
    expect((await client.completeStream!(REQ, {})).message.content).toBe("streams again");
    expect(calls.at(-1)).toEqual({ stream: true });
  });

  it("any other failure is not hidden by the fallback", async () => {
    const { calls, fetchImpl } = fake([() => Response.json({ error: { message: "bad key" } }, { status: 401 })]);
    const client = routerChatClient(CHAT, { stream: true, fetchImpl });
    await expect(client.completeStream!(REQ, {})).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });

  it("without --stream-speech it still offers no streaming at all, as before", () => {
    expect(routerChatClient(CHAT).completeStream).toBeUndefined();
    expect(routerChatClient(CHAT, { stream: false }).completeStream).toBeUndefined();
  });
});

describe("--stream-speech", () => {
  it("is a flag, an environment variable and a remembered setting, and is off unless asked for", () => {
    expect(parseArgs(["hi"]).streamSpeech).toBe(false);
    expect(parseArgs(["--stream-speech", "hi"]).streamSpeech).toBe(true);
    expect(parseArgs(["hi"], { HEARTH_STREAM_SPEECH: "1" }).streamSpeech).toBe(true);
    expect(parseArgs(["hi"], configAsEnv({ streamSpeech: true })).streamSpeech).toBe(true);
    expect(parseArgs(["--no-stream-speech", "hi"], configAsEnv({ streamSpeech: true })).streamSpeech).toBe(false);   // flag beats config
  });
});
