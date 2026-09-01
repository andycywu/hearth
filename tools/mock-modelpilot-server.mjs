#!/usr/bin/env node
/**
 * A ModelPilot stand-in, for manual runs and for driving a real device without
 * spending real money on a real router.
 *
 *   node tools/mock-modelpilot-server.mjs [--port 8090] [--answer set_input:hdmi3]
 *                                          [--idle <seconds, 0 = never>]
 *
 * Speaks the three endpoints ModelPilot actually has — `GET /v1/models`,
 * `POST /v1/chat/completions`, `POST /v1/feedback` — and answers with an
 * OpenAI-shaped completion whose content is one TV action plan, plus the
 * `modelpilot` extension the real Worker attaches.
 *
 * **This file used to lie.** It implemented `POST /v1/tasks/execute` and
 * `GET /v1/trajectories/:id` with task ids and a per-task verification verdict,
 * because that is what the integration was written against, and none of it
 * exists. Forty-six tests were green against a protocol nobody speaks. A mock is
 * a claim about somebody else's server; when it is wrong it does not fail, it
 * agrees with you.
 *
 * Every request is echoed to stderr **with the authorization header removed**,
 * so a manual run can show what crossed the boundary without putting a
 * credential in a terminal scrollback.
 *
 * Answers (`--answer`):
 *   set_input:hdmi3     switch to an input the local planner would not have picked
 *   set_volume:12       set an absolute level
 *   pause               pause playback
 *   ask_user            a legitimate "I need a human" answer
 *   power               an action no adapter implements — expect a rejection
 *   invalid             a plan missing required keys — expect no device operation
 *   not-a-plan          a 200 whose content is plausible prose rather than a
 *                       plan. Not an error anywhere until the parser.
 *   no-model            422, the shape a tenant with no provider credential (or
 *                       too high a quality threshold) actually gets
 *   quota               429, the Free plan's 1000-requests-a-month wall
 *   slow                never answers, so the client's timeout is exercised
 */
import { createServer } from "node:http";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const port = Number(opt("--port", 8090));
const answer = String(opt("--answer", "set_input:hdmi3"));
let requestCounter = 0;

/** Enough of a catalogue for a bring-up screen to have something to render. */
const MODELS = ["openai-mini", "claude-sonnet", "gemini-flash", "openrouter-auto"];

function planFor(spec) {
  const [kind, value] = spec.split(":");
  switch (kind) {
    case "set_volume":
      return {
        action: "set_volume", target: "tv",
        parameters: { level: Number(value ?? 12) },
        expected_state: { "tv.volume": Number(value ?? 12) },
        risk: "low", reason: "mock: absolute level",
      };
    case "pause":
      return {
        action: "pause", target: "tv", parameters: {},
        expected_state: { "content.state": "paused" }, risk: "low", reason: "mock: pause",
      };
    case "ask_user":
      return {
        action: "ask_user", target: "tv",
        parameters: { question: "Which input did you mean?" },
        expected_state: {}, risk: "low", reason: "mock: ambiguous request",
      };
    case "power":
      return {
        action: "power", target: "tv", parameters: { state: "off" },
        expected_state: { "tv.power": "off" }, risk: "high", reason: "mock: unimplemented action",
      };
    case "invalid":
      // Two of the five required keys missing: the local parser must refuse and
      // no device operation may happen.
      return { action: "set_input", target: "tv", parameters: { source: "hdmi3" } };
    case "set_input":
    default:
      return {
        action: "set_input", target: "tv",
        parameters: { source: value ?? "hdmi3" },
        expected_state: { "tv.input": value ?? "hdmi3" },
        risk: "low", reason: "mock: the set-top box is there",
      };
  }
}

/**
 * The response shape, copied from the Worker rather than imagined.
 *
 * Note `evaluation_status: "unverified"` — it is that on every fresh completion
 * from the real service, and it is here so that anything gating on it fails in a
 * manual run rather than on a television.
 */
function completion(content, model) {
  const requestId = `mock-req-${++requestCounter}`;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 220, completion_tokens: 48, total_tokens: 268 },
    modelpilot: {
      request_id: requestId,
      selected_model: model,
      provider: "openai",
      routing_reason: "mock: highest policy-adjusted score for structured_extraction",
      fallback_count: 0,
      actual_cost: 0.0021,
      baseline_cost: 0.0184,
      evaluation_status: "unverified",
    },
  };
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    // Never the authorization header. This is a debugging tool, and a debugging
    // tool that prints credentials is how they end up in a bug report.
    console.error(`[mock-modelpilot] ${req.method} ${req.url}`);

    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    const fail = (status, message, type) => send(status, { error: { message, type } });

    if (req.url?.startsWith("/v1/models")) {
      return send(200, { object: "list", data: MODELS.map((id) => ({ id, object: "model" })) });
    }

    if (req.url?.startsWith("/v1/feedback")) {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* reported below */ }
      if (typeof parsed.request_id !== "string" || typeof parsed.success !== "boolean") {
        return fail(422, "request_id and success are required");
      }
      // The half of the loop that makes CST mean anything: a verdict from
      // something that actually watched the television.
      console.error(`[mock-modelpilot]   feedback ${parsed.request_id} success=${parsed.success} score=${parsed.score ?? "-"}`);
      return send(200, { status: "accepted" });
    }

    if (!req.url?.startsWith("/v1/chat/completions")) {
      return fail(404, `no such path: ${req.url}`, "invalid_request_error");
    }

    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return fail(400, "messages is required", "invalid_request_error");
    }

    // What crossed the boundary. Read this line in a manual run and confirm
    // there is nothing in it you would not want in a log.
    const user = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
    console.error(`[mock-modelpilot]   model=${parsed.model} metadata=${JSON.stringify(parsed.metadata ?? {})}`);
    console.error(`[mock-modelpilot]   user=${String(user).replace(/\n/g, " | ")}`);

    // The real service rejects streaming outright rather than quietly answering
    // without it, so the mock must too — a client that streams needs to break
    // here, not on a TV.
    if (parsed.stream) {
      return fail(400, "Streaming is not enabled in the Free-first release", "invalid_request_error");
    }
    if (!Array.isArray(parsed.messages) || !parsed.messages.length) {
      return fail(400, "messages is required", "invalid_request_error");
    }

    if (answer === "slow") return;                      // never answers, on purpose
    if (answer === "quota") return fail(429, "Monthly request limit reached", "rate_limit_error");
    if (answer === "no-model") {
      return fail(422, "No eligible configured model satisfies this request policy", "routing_error");
    }
    if (answer === "not-a-plan") {
      // The failure with no error code anywhere: a model answering the question
      // instead of returning the object. The strict parser is the only thing
      // between this and a device operation.
      return send(200, completion(
        "Sure — which input did you want, and shall I turn it up?",
        "openai-mini",
      ));
    }

    return send(200, completion(planFor(answer), "openai-mini"));
  });
});

/**
 * Shut down when nothing has used it for a while. `--idle 0` disables it.
 *
 * Five of these were found still running days after their tests finished,
 * holding five ports and — because they were started as
 * `node tools/mock-modelpilot-server.mjs` with a relative path — a working
 * directory handle on the repository root, which is what made the project
 * folder un-renameable. A fixture that outlives its test is not harmless: it is
 * a process nobody is watching, answering on a port somebody else may want.
 */
const idleMs = Number(opt("--idle", 900)) * 1000;
let idleTimer;
function touch() {
  if (!idleMs) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error(`[mock-modelpilot] idle for ${idleMs / 1000}s — exiting`);
    server.close(() => process.exit(0));
  }, idleMs);
  // Don't let the timer alone keep the process alive once the server closes.
  idleTimer.unref?.();
}
server.on("request", touch);

server.listen(port, () => {
  console.error(`[mock-modelpilot] listening on http://127.0.0.1:${port} (answer: ${answer})`);
  console.error("[mock-modelpilot] point the runtime at it:");
  console.error(`[mock-modelpilot]   MODELPILOT_BASE_URL=http://127.0.0.1:${port} MODELPILOT_API_KEY=test-key MODELPILOT_MODE=shadow`);
  if (idleMs) console.error(`[mock-modelpilot] will exit after ${idleMs / 1000}s idle (--idle 0 to stay up)`);
  touch();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
