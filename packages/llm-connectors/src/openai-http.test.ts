import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { createOpenAiCompatibleClient } from "./openai-compatible.js";

/**
 * A tiny OpenAI-compatible SSE server. First call streams a tool_call
 * (set_volume); once it sees a tool result in the transcript, it streams a
 * final text answer. Exercises the real HTTP + SSE + tool-call assembly path in
 * createOpenAiCompatibleClient end-to-end through the agent loop.
 */
function startMockServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = JSON.parse(body || "{}");
        const hasToolResult = (json.messages ?? []).some((m: any) => m.role === "tool");
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (!hasToolResult) {
          res.write(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1",' +
              '"function":{"name":"set_volume","arguments":"{\\"level\\":55}"}}]}}]}\n\n',
          );
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Volume is now 55."}}]}\n\n');
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

describe("openai-compatible client over real HTTP", () => {
  it("drives the full agent loop: tool call → result → streamed final answer", async () => {
    const { server, baseUrl } = await startMockServer();
    try {
      const platform = createWebAdapter();
      const llm = createOpenAiCompatibleClient({ baseUrl, model: "mock" });
      const agent = new Agent({ platform, llm });

      const tokens: string[] = [];
      const tools: string[] = [];
      agent.events.on("token", (e) => tokens.push(e.delta));
      agent.events.on("tool:call", (e) => tools.push(e.name));

      const out = await agent.run("make it 55");

      expect(tools).toContain("set_volume");
      expect(await platform.system.getVolume()).toBe(55);
      expect(out).toContain("55");
      expect(tokens.join("")).toContain("55"); // streamed, not just returned
    } finally {
      server.close();
    }
  });
});
