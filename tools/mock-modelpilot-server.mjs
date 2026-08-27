#!/usr/bin/env node
/**
 * A ModelPilot stand-in, for manual runs and for driving a real device without
 * spending real money on a real engine.
 *
 *   node tools/mock-modelpilot-server.mjs [--port 8090] [--answer set_input:hdmi3]
 *
 * Speaks the three documented REST paths and returns a verified task whose
 * output is one TV action plan. Every request is echoed to stderr **with the
 * authorization header removed**, so a manual run can show what crossed the
 * boundary without putting a credential in a terminal scrollback.
 *
 * Answers (`--answer`):
 *   set_input:hdmi3     switch to an input the local planner would not have picked
 *   set_volume:12       set an absolute level
 *   pause               pause playback
 *   ask_user            a legitimate "I need a human" answer
 *   power               an action no adapter implements — expect a rejection
 *   invalid             a plan missing required keys — expect no device operation
 *   unverified          a task ModelPilot itself does not stand behind
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
let taskCounter = 0;

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

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    // Never the authorization header. This is a debugging tool, and a debugging
    // tool that prints credentials is how they end up in a bug report.
    const headers = { ...req.headers };
    delete headers.authorization;
    console.error(`[mock-modelpilot] ${req.method} ${req.url}`);
    if (body) {
      try {
        const parsed = JSON.parse(body);
        console.error(`[mock-modelpilot]   strategy=${parsed.strategy} sensitivity=${parsed.requirements?.dataPolicy?.sensitivity}`);
        console.error(`[mock-modelpilot]   context=${parsed.task?.context}`);
      } catch {
        console.error(`[mock-modelpilot]   (unparsed body, ${body.length} bytes)`);
      }
    }

    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };

    if (answer === "slow") return;                      // never answers, on purpose

    const id = `mock-task-${++taskCounter}`;
    const trajectoryId = `mock-traj-${taskCounter}`;

    if (req.url?.startsWith("/v1/tasks/execute")) {
      if (answer === "unverified") {
        return send(200, { taskId: id, trajectoryId, status: "unverified", actualCost: 0.001, output: planFor("set_input:hdmi3") });
      }
      return send(200, {
        taskId: id, trajectoryId, status: "verified", actualCost: 0.002,
        output: planFor(answer),
      });
    }
    if (req.url?.startsWith("/v1/tasks/")) {
      return send(200, { taskId: req.url.split("/").pop(), status: "verified", evidence: { mock: true } });
    }
    if (req.url?.startsWith("/v1/trajectories/")) {
      return send(200, { trajectoryId: req.url.split("/").pop(), steps: [{ mock: true }] });
    }
    send(404, { error: "not a documented ModelPilot path" });
  });
});

server.listen(port, () => {
  console.error(`[mock-modelpilot] listening on http://127.0.0.1:${port} (answer: ${answer})`);
  console.error("[mock-modelpilot] point the runtime at it:");
  console.error(`[mock-modelpilot]   MODELPILOT_BASE_URL=http://127.0.0.1:${port} MODELPILOT_API_KEY=test-key MODELPILOT_MODE=shadow`);
});
