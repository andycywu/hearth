import { ModelPilotError } from "./errors.js";
import type { CompletionRequest } from "./task-mapper.js";

/**
 * The ModelPilot transport.
 *
 * **What this file used to assume, and what is actually there.** It was written
 * against a decision engine: `POST /v1/tasks/execute`, `GET /v1/tasks/:id`,
 * `GET /v1/trajectories/:id`, task ids, trajectory ids, a per-task verification
 * verdict. None of those exist. ModelPilot is a cost-aware *model routing*
 * control plane, and its entire public API is three endpoints:
 *
 *   - `GET  /v1/models`            — the catalogue
 *   - `POST /v1/chat/completions`  — OpenAI-compatible; `model: "auto"` routes
 *   - `POST /v1/feedback`          — `{ request_id, success, score? }`
 *
 * So the transport is an OpenAI-compatible POST, and the identity of a call is
 * `modelpilot.request_id` — the handle `/v1/feedback` takes, which is how the
 * local verifier's verdict gets back to the service that needs it.
 *
 * **REST, not MCP** — unchanged, and for the same reason (ADR-0004): this bundle
 * ships in a TV WebView under a size budget with no dependencies, and one
 * request/response call does not justify JSON-RPC over SSE plus a session
 * lifecycle. It is a weaker decision than it was, because there is no MCP
 * surface left to weigh it against.
 *
 * **What is still unproven**: not the shapes — those are read off the deployed
 * Worker — but the behaviour of a live tenant: provider credentials, plan
 * limits, and the 429 a Free plan produces at 1000 requests a month.
 */

export interface ModelPilotAnswer {
  /** The assistant's message content, unparsed. `parseActionPlan` decides. */
  output: unknown;
  /** `modelpilot.request_id` — the handle `/v1/feedback` takes. */
  requestId?: string;
  /** Which model the router actually chose, e.g. `openai-mini`. */
  selectedModel?: string;
  provider?: string;
  /** The router's own explanation of the choice. */
  routingReason?: string;
  /** How many candidates failed before this one answered. */
  fallbackCount?: number;
  actualCost?: number;
  /** What the most expensive eligible candidate would have cost. */
  baselineCost?: number;
  /**
   * ModelPilot's CST bookkeeping, and **never a gate on this answer**.
   *
   * It is `"unverified"` on every fresh completion, by design: the service does
   * not count a task successful until a verifier says so. Reading that as "the
   * answer is unusable" — which this integration did — meant enforce mode
   * blocked on every single call. Whether the *plan* is usable is decided by
   * `parseActionPlan`; whether the *television* did it is decided by the local
   * read-back. This field is neither.
   */
  evaluationStatus?: string;
  latencyMs: number;
  /** Fields the response did not carry, for the integration to log once. */
  missing: string[];
}

export interface ModelPilotClientOptions {
  /** Service origin. `/v1/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  /** Per-call budget. Also the AbortController deadline. Default 8000ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Override when a deployment's paths differ. */
  paths?: Partial<typeof DEFAULT_PATHS>;
  /**
   * Who is calling, for the backend to count installs and usage.
   *
   * Pseudonymous and device-generated (`loadInstallId`), never a hardware
   * identifier. It rides on calls that were happening anyway rather than on a
   * separate analytics channel, which is why `MODELPILOT_MODE=off` means no
   * signal at all: the runtime is offline by default and stays that way unless a
   * host configures a credential.
   */
  identity?: { installId?: string; runtimeVersion?: string; mode?: string };
  now?: () => number;
}

const DEFAULT_PATHS = {
  completions: "/v1/chat/completions",
  models: "/v1/models",
  feedback: "/v1/feedback",
};

export interface CallOptions {
  /** Caller cancellation, combined with the client's own timeout. */
  signal?: AbortSignal;
}

/**
 * A verdict on an earlier completion, posted to `/v1/feedback`.
 *
 * ModelPilot's primary metric is Cost Per Successful Task, and it deliberately
 * refuses to count a completed API call as a successful task until something
 * confirms the outcome. On a television, **this runtime is that something** —
 * and a better verifier than user feedback, because it read the device back.
 *
 * `score` is optional and deliberately usually omitted: a made-up number is
 * noise in someone else's denominator.
 */
export interface OutcomeReport {
  success: boolean;
  score?: number;
  comment?: string;
}

export interface ModelPilotClient {
  /** One routed completion. The answer is a *proposal*, never a result. */
  complete(request: CompletionRequest, opts?: CallOptions): Promise<ModelPilotAnswer>;
  /** The catalogue, for a bring-up screen that wants to show what is routable. */
  listModels(opts?: CallOptions): Promise<unknown>;
  /**
   * Tell ModelPilot whether the television actually did it.
   *
   * The one call in this client that is not on the path to a device operation,
   * so a caller must be free to let it fail: the planner reports it as telemetry
   * and carries on.
   */
  reportOutcome(requestId: string, report: OutcomeReport, opts?: CallOptions): Promise<void>;
}

export function createModelPilotClient(opts: ModelPilotClientOptions): ModelPilotClient {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 8000;
  const paths = { ...DEFAULT_PATHS, ...opts.paths };
  const now = opts.now ?? (() => Date.now());
  const base = opts.baseUrl.replace(/\/+$/, "");

  /**
   * One request, one deadline, one place the key is attached.
   *
   * The key goes into a header and nowhere else: not the URL, not the body, not
   * an error message. Errors carry the status and the path, which is what a
   * reader needs, and never the header.
   */
  async function call(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    callOpts: CallOptions = {},
  ): Promise<{ json: unknown; latencyMs: number }> {
    const started = now();
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(new Error("timeout")), timeoutMs)
      : undefined;
    const onAbort = (): void => controller?.abort(new Error("cancelled"));
    callOpts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          // The one place the credential appears.
          authorization: `Bearer ${opts.apiKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          // Attribution, so the service can answer "how many televisions, how
          // often, on which version" without a second endpoint and without
          // anything that identifies hardware or a household.
          ...(opts.identity?.installId ? { "x-hearth-install": opts.identity.installId } : {}),
          ...(opts.identity?.runtimeVersion ? { "x-hearth-runtime": opts.identity.runtimeVersion } : {}),
          ...(opts.identity?.mode ? { "x-hearth-mode": opts.identity.mode } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });

      const latencyMs = now() - started;
      const text = await readBody(res);

      if (!res.ok) throw classify(res.status, path, text, opts.apiKey);

      if (text.length > MAX_RESPONSE_BYTES) {
        throw new ModelPilotError("server", "ModelPilot response was too large to read");
      }
      try {
        return { json: text ? JSON.parse(text) : null, latencyMs };
      } catch {
        throw new ModelPilotError("server", "ModelPilot did not return JSON");
      }
    } catch (err) {
      if (err instanceof ModelPilotError) throw err;
      // Our own abort is the authority, not the shape of what fetch threw.
      //
      // `controller.abort(reason)` makes some runtimes reject with *the reason*
      // rather than an `AbortError`, so the name check alone reported every
      // real timeout as `unreachable`. Unit tests could not see it — they mock
      // fetch and throw a properly named AbortError — and the end-to-end run
      // against `--answer slow` printed
      // `unreachable: could not reach ModelPilot: timeout`, which is two
      // different diagnoses in one line. Asking the controller removes the guess.
      const name = (err as { name?: string })?.name;
      if (controller?.signal.aborted || name === "AbortError" || name === "TimeoutError") {
        const cancelled = callOpts.signal?.aborted === true;
        throw new ModelPilotError(
          "timeout",
          cancelled ? "the caller cancelled the ModelPilot call" : `no answer from ModelPilot within ${timeoutMs}ms`,
          { cause: err },
        );
      }
      // A fetch that never reached anything looks like this everywhere.
      //
      // No `cause`: an underlying fetch error carries the request URL in its
      // message and its stack, and a host that has put a token in a query string
      // would have it propagate into every log that prints this error. A test
      // caught exactly that. The kind, the message and the status carry the
      // diagnostic weight; the stack is not worth a credential.
      throw new ModelPilotError("unreachable", describeNetworkError(err, opts.apiKey));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callOpts.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    complete: async (request, callOpts) => {
      const { json, latencyMs } = await call("POST", paths.completions, request, callOpts);
      return readAnswer(json, latencyMs);
    },
    listModels: async (callOpts) =>
      (await call("GET", paths.models, undefined, callOpts)).json,

    reportOutcome: async (requestId, report, callOpts) => {
      await call("POST", paths.feedback, {
        request_id: requestId,
        success: report.success,
        ...(report.score !== undefined ? { score: report.score } : {}),
        ...(report.comment ? { comment: report.comment } : {}),
      }, callOpts);
    },
  };
}

const MAX_RESPONSE_BYTES = 512 * 1024;

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * A status code and an error body, turned into the one thing the caller has to
 * decide: fall back locally, or not.
 *
 * `429` earns its own kind because it is the failure a shipped fleet will
 * actually hit — the Free plan is 1000 requests a month per *tenant*, so one
 * heavy household on a shared key exhausts it for every other television on
 * that key. "The engine is down" and "you are out of quota" want different
 * reactions from whoever is watching, so they are not the same kind.
 */
function classify(status: number, path: string, body: string, apiKey: string): ModelPilotError {
  const detail = errorMessage(body, apiKey);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) {
    return new ModelPilotError("unauthorized", `ModelPilot refused the credential (${status})${suffix}`, { status });
  }
  if (status === 429) {
    return new ModelPilotError("rate_limited", `ModelPilot declined for quota (429)${suffix}`, { status });
  }
  if (status >= 500) {
    return new ModelPilotError("server", `ModelPilot answered ${status}${suffix}`, { status });
  }
  return new ModelPilotError("rejected", `ModelPilot answered ${status} for ${path}${suffix}`, { status });
}

/**
 * The service's own `{ error: { message, type } }`, redacted, or nothing.
 *
 * Worth carrying: `422 No eligible configured model satisfies this request
 * policy` is the difference between "ModelPilot is broken" and "this tenant has
 * no provider credential, or the quality threshold excluded everything", and a
 * bare status code cannot tell those apart.
 */
function errorMessage(body: string, apiKey: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === "string" && message) return redact(message, apiKey).slice(0, 200);
  } catch { /* not JSON; a body we cannot read adds nothing to the status */ }
  return undefined;
}

/**
 * Read the routing metadata and the answer out of an OpenAI-shaped response.
 *
 * `output` is `choices[0].message.content` — a *string*, which is what a model
 * returns. Unwrapping fences, prose and nesting is `parseActionPlan`'s job, and
 * keeping that in one place is why this function does not try to be clever.
 *
 * `missing` exists so a gap is reported once rather than logged as `undefined`
 * forever. It no longer lists a trajectory id, because there is no such thing.
 */
export function readAnswer(json: unknown, latencyMs: number): ModelPilotAnswer {
  const root = isObject(json) ? json : {};
  const meta = isObject(root.modelpilot) ? root.modelpilot : {};
  // ModelPilot's extension first, then the envelope: `model` exists in both, and
  // the routed choice is the one worth recording.
  const pick = (...names: string[]): unknown => {
    for (const n of names) {
      if (meta[n] !== undefined) return meta[n];
      if (root[n] !== undefined) return root[n];
    }
    return undefined;
  };

  const requestId = str(pick("request_id", "requestId", "id"));
  const selectedModel = str(pick("selected_model", "selectedModel", "model"));
  const provider = str(pick("provider"));
  const routingReason = str(pick("routing_reason", "routingReason"));
  const fallbackCount = num(pick("fallback_count", "fallbackCount"));
  const actualCost = num(pick("actual_cost", "actualCost", "cost"));
  const baselineCost = num(pick("baseline_cost", "baselineCost"));
  const evaluationStatus = str(pick("evaluation_status", "evaluationStatus"));

  const missing: string[] = [];
  if (!requestId) missing.push("request_id");
  if (!selectedModel) missing.push("selected_model");
  if (actualCost === undefined) missing.push("actual_cost");

  return {
    output: readContent(root),
    ...(requestId ? { requestId } : {}),
    ...(selectedModel ? { selectedModel } : {}),
    ...(provider ? { provider } : {}),
    ...(routingReason ? { routingReason } : {}),
    ...(fallbackCount !== undefined ? { fallbackCount } : {}),
    ...(actualCost !== undefined ? { actualCost } : {}),
    ...(baselineCost !== undefined ? { baselineCost } : {}),
    ...(evaluationStatus ? { evaluationStatus } : {}),
    latencyMs,
    missing,
  };
}

/**
 * The assistant's content, or the whole body when there is no completion in it.
 *
 * The fallback is not politeness: a deployment that answers something other
 * than a completion should reach the parser and be rejected there with what
 * actually arrived visible, rather than becoming `undefined` here and producing
 * a rejection that says nothing.
 */
function readContent(root: Record<string, unknown>): unknown {
  const choices = root.choices;
  if (Array.isArray(choices) && choices.length) {
    const first = choices[0];
    const message = isObject(first) && isObject(first.message) ? first.message : undefined;
    if (message && message.content !== undefined) return message.content;
  }
  return root;
}

function describeNetworkError(err: unknown, apiKey: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return `could not reach ModelPilot: ${redact(message, apiKey).slice(0, 160)}`;
}

/**
 * Remove anything credential-shaped from text on its way to a log.
 *
 * Both halves matter: the key this client holds, and the generic
 * `authorization=` pair, because the next leak will be a credential we were
 * never given and so cannot match exactly.
 */
export function redact(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join("[redacted]");
  // The whole pair is replaced, including the label — matching only the value
  // and its lead-in would leave "Authorization: Bearer" printing the key.
  return out.replace(
    /((?:api[_-]?key|token|secret|password|authorization)["'\s:=]+(?:bearer\s+)?|bearer\s+)([^\s"'&,}]+)/gi,
    "$1[redacted]",
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
