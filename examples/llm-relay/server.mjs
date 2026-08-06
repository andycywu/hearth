#!/usr/bin/env node
/**
 * A minimal OpenAI-compatible relay, so the API key never reaches the TV.
 *
 * The TV points at this instead of at the provider:
 *
 *     adb shell am start -n tv.aiagent.harness/.MainActivity \
 *       -e start 'index.html?llm=https://relay.example.com/v1'
 *
 * and the key lives here, in the relay's environment. This is the only
 * arrangement that survives a television in someone else's hands: everything
 * else — a key in the launch URL, a key in the app bundle, a key in the host's
 * encrypted store — puts the credential on a device you don't control, where it
 * is the same key for every unit of that model. One extraction and it is gone
 * for all of them.
 *
 * Deliberately about a hundred lines. It is a reference, not a product: no
 * accounts, no rate limiting per user, no persistence. What it does do is the
 * part that is easy to get wrong — pass the request through unchanged so tool
 * calling and streaming keep working, and never echo the key.
 *
 *     UPSTREAM_API_KEY=sk-… node server.mjs
 *
 * Environment:
 *   UPSTREAM_API_KEY   required — the provider key
 *   UPSTREAM_BASE_URL  default https://api.openai.com/v1
 *   PORT               default 8787
 *   ALLOW_ORIGIN       default *  — the TV page's origin; see below
 *   RELAY_TOKEN        optional — a shared secret the TV must send
 */
import { createServer } from "node:http";

const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY;
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? "*";
const RELAY_TOKEN = process.env.RELAY_TOKEN;

if (!UPSTREAM_API_KEY) {
  console.error("UPSTREAM_API_KEY is required. Refusing to start without it.");
  process.exit(1);
}

createServer(async (req, res) => {
  // The TV page is served from its own origin, so every call here is
  // cross-origin. Without these the browser rejects it at preflight and the
  // only sign is a console line — see docs/on-device-inference.md.
  res.setHeader("access-control-allow-origin", ALLOW_ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  if (!req.url?.startsWith("/v1/")) {
    return void res.writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "only /v1/* is relayed" }));
  }

  // Optional shared secret. Not a substitute for real auth — it is one value for
  // every TV, so it limits casual abuse of an open relay and nothing more. Say
  // that plainly rather than let it look like access control.
  if (RELAY_TOKEN && req.headers.authorization !== `Bearer ${RELAY_TOKEN}`) {
    return void res.writeHead(401, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "bad relay token" }));
  }

  const body = await readBody(req);
  try {
    const upstream = await fetch(UPSTREAM_BASE_URL + req.url.slice(3), {
      method: req.method ?? "POST",
      headers: {
        "content-type": "application/json",
        // The substitution this whole file exists for: whatever the TV sent as
        // authorization is discarded, and the real key is added here.
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
      },
      body,
    });

    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "access-control-allow-origin": ALLOW_ORIGIN,
    });
    // Streamed straight through: the agent asks for SSE, and buffering it here
    // would turn a reply that appears word by word into one that appears all at
    // once several seconds later.
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    // Never include the key or the upstream URL in what goes back to the TV.
    console.error("[relay] upstream failed:", err?.message ?? err);
    res.writeHead(502, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "upstream unreachable" }));
  }
}).listen(PORT, () => {
  console.log(`[relay] :${PORT} → ${UPSTREAM_BASE_URL}`);
  console.log(`[relay] allowed origin: ${ALLOW_ORIGIN}${RELAY_TOKEN ? " (relay token required)" : ""}`);
});

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });
}
