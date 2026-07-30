#!/usr/bin/env node
/**
 * Serves the offline scripted brain over HTTP as an OpenAI-compatible
 * `/v1/chat/completions` endpoint.
 *
 *   node tools/mock-llm-server.mjs [--port 8080] [--host 127.0.0.1]
 *
 * Why: bring-up needs *some* brain on the device, and a real model adds its own
 * variability right when you're trying to prove the platform layer. Pointing a TV
 * at this server means the on-device run uses the exact same decisions as
 * `packages/acceptance` in CI, so any difference in the tool sequence is the
 * device's doing, not the model's.
 *
 * Requires `pnpm build` first (imports the built dist/).
 *
 * On Android, expose it to the device without touching the app's CSP:
 *   adb reverse tcp:8080 tcp:8080     # device 127.0.0.1:8080 → this server
 */
import { createServer } from "node:http";

const { createScriptedClient } = await import("../packages/llm-connectors/dist/index.js");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(opt("--port", 8080));
const host = opt("--host", "127.0.0.1");

const brain = createScriptedClient();

/** OpenAI wire message → the ChatMessage shape the core uses. */
function fromApiMessage(m) {
  if (m.role === "tool") return { role: "tool", toolCallId: m.tool_call_id, content: m.content ?? "" };
  if (m.role === "assistant" && m.tool_calls?.length) {
    return {
      role: "assistant",
      content: m.content ?? "",
      toolCalls: m.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        args: safeParse(tc.function?.arguments),
      })),
    };
  }
  return { role: m.role, content: m.content ?? "" };
}

/** CompletionResult → an OpenAI non-streaming response body. */
function toApiResponse(result) {
  const msg = result.message;
  return {
    id: "mock-scripted",
    object: "chat.completion",
    model: "scripted-offline",
    choices: [{
      index: 0,
      finish_reason: result.wantsToolCalls ? "tool_calls" : "stop",
      message: {
        role: "assistant",
        content: msg.content || null,
        ...(msg.toolCalls?.length
          ? {
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            }
          : {}),
      },
    }],
  };
}

/** Same payload as SSE, so the streaming path gets exercised too. */
function toSse(result) {
  const msg = result.message;
  const frames = [];
  if (msg.toolCalls?.length) {
    msg.toolCalls.forEach((tc, index) => {
      frames.push({
        choices: [{
          delta: {
            tool_calls: [{
              index,
              id: tc.id,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            }],
          },
        }],
      });
    });
  } else {
    // Word-sized chunks so the device UI visibly streams.
    for (const chunk of (msg.content || "").match(/\S+\s*/g) ?? []) {
      frames.push({ choices: [{ delta: { content: chunk } }] });
    }
  }
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

const server = createServer((req, res) => {
  // The device fetches cross-origin from file:// or the app origin.
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-methods": "POST,OPTIONS",
  };
  if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();

  if (req.method === "GET" && req.url === "/health") {
    return void res.writeHead(200, { "content-type": "application/json", ...cors })
      .end(JSON.stringify({ ok: true, brain: brain.id }));
  }

  if (!req.url?.endsWith("/chat/completions")) {
    return void res.writeHead(404, cors).end("not found");
  }

  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}");
      const request = {
        messages: (parsed.messages ?? []).map(fromApiMessage),
        // Tool specs come back as OpenAI function defs; the brain only needs names.
        tools: (parsed.tools ?? []).map((t) => ({
          name: t.function?.name,
          description: t.function?.description ?? "",
          parameters: t.function?.parameters?.properties ?? {},
        })),
      };
      const result = await brain.complete(request);
      const last = request.messages[request.messages.length - 1];
      console.log(
        `[mock-llm] ${last?.role ?? "-"} "${short(last?.content)}" → ` +
        (result.wantsToolCalls
          ? result.message.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(", ")
          : `"${short(result.message.content)}"`),
      );

      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors });
        res.end(toSse(result));
      } else {
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify(toApiResponse(result)));
      }
    } catch (err) {
      console.error("[mock-llm] error:", err);
      res.writeHead(500, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(port, host, () => {
  console.log(`[mock-llm] scripted brain on http://${host}:${port}/v1 (health: /health)`);
  console.log("[mock-llm] Android: adb reverse tcp:%d tcp:%d, then ?llm=http://127.0.0.1:%d/v1", port, port, port);
});

function safeParse(s) {
  try { return JSON.parse(s ?? "{}"); } catch { return {}; }
}
function short(s, max = 40) {
  const t = String(s ?? "").replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
