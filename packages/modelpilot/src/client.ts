import { ModelPilotError } from "./errors.js";
import type { TaskRequest } from "./task-mapper.js";

/**
 * The ModelPilot transport.
 *
 * **REST, not MCP, and the reason is the runtime.** This bundle ships inside a
 * TV WebView under a size budget, targets ES2020, and has no dependencies at
 * all; a Remote MCP client means JSON-RPC over SSE or streamable HTTP plus a
 * session lifecycle, which is a lot of bytes and a lot of failure modes to put
 * on a television for a request/response call. The four operations below map
 * cleanly onto `fetch`, so they use `fetch`. If MCP becomes the better transport
 * — because a tool gains streaming or server-initiated messages — it slots in
 * behind this same interface.
 *
 * **What is assumed, so it can be corrected in one place.** Three REST paths are
 * documented: `POST /v1/tasks/execute`, `GET /v1/tasks/:id`,
 * `GET /v1/trajectories/:id`. `decideExecution` has no documented REST path, so
 * it is mapped onto the execute endpoint with `strategy: "decide"`, which is an
 * assumption and is marked as one. If ModelPilot exposes a dedicated decision
 * endpoint, override `paths.decide` — one line, no other change.
 *
 * The response shape is read tolerantly for the same reason: the ids and status
 * are looked for under several plausible names rather than one guessed schema,
 * and anything not found is reported as missing rather than defaulted.
 */

export interface ModelPilotTaskResult {
  /** Whatever the engine returned as the answer, unparsed. */
  output: unknown;
  taskId?: string;
  trajectoryId?: string;
  /** As reported by ModelPilot — `verified`, `unverified`, `failed`, … */
  status?: string;
  verified?: boolean;
  actualCost?: number;
  latencyMs: number;
  /** Fields the response did not carry, for the integration to log once. */
  missing: string[];
}

export interface ModelPilotClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-call budget. Also the AbortController deadline. Default 5000ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Override when the service's paths differ from the documented ones. */
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
  execute: "/v1/tasks/execute",
  decide: "/v1/tasks/execute",
  task: "/v1/tasks/",
  trajectory: "/v1/trajectories/",
};

export interface CallOptions {
  /** Caller cancellation, combined with the client's own timeout. */
  signal?: AbortSignal;
}

export interface ModelPilotClient {
  decideExecution(request: TaskRequest, opts?: CallOptions): Promise<ModelPilotTaskResult>;
  executeVerifiedTask(request: TaskRequest, opts?: CallOptions): Promise<ModelPilotTaskResult>;
  getTaskEvidence(taskId: string, opts?: CallOptions): Promise<unknown>;
  getTaskTrajectory(taskId: string, opts?: CallOptions): Promise<unknown>;
}

export function createModelPilotClient(opts: ModelPilotClientOptions): ModelPilotClient {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 5000;
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
      if (res.status === 401 || res.status === 403) {
        throw new ModelPilotError("unauthorized", `ModelPilot refused the credential (${res.status})`, { status: res.status });
      }
      if (res.status >= 500) {
        throw new ModelPilotError("server", `ModelPilot answered ${res.status}`, { status: res.status });
      }
      if (!res.ok) {
        throw new ModelPilotError("rejected", `ModelPilot answered ${res.status} for ${path}`, { status: res.status });
      }

      const text = await res.text();
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
      const name = (err as { name?: string })?.name;
      if (name === "AbortError" || name === "TimeoutError") {
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

  async function task(path: string, request: TaskRequest, callOpts?: CallOptions): Promise<ModelPilotTaskResult> {
    const { json, latencyMs } = await call("POST", path, request, callOpts);
    return readTaskResult(json, latencyMs);
  }

  return {
    decideExecution: (request, callOpts) =>
      // The assumption noted above, made visible in the payload rather than
      // hidden in a URL: if the service ignores `strategy`, the answer is still
      // an execution decision and the caller reads the same fields.
      task(paths.decide, { ...request, strategy: "decide" }, callOpts),

    executeVerifiedTask: (request, callOpts) => task(paths.execute, request, callOpts),

    getTaskEvidence: async (taskId, callOpts) =>
      (await call("GET", `${paths.task}${encodeURIComponent(taskId)}`, undefined, callOpts)).json,

    getTaskTrajectory: async (taskId, callOpts) =>
      (await call("GET", `${paths.trajectory}${encodeURIComponent(taskId)}`, undefined, callOpts)).json,
  };
}

const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * Read the ids and status out of the response without pretending to know its
 * schema.
 *
 * Several plausible names are tried per field, and whatever is absent is listed
 * in `missing` so the integration can say "ModelPilot answered but gave no
 * trajectory id" instead of logging `undefined` and moving on. That distinction
 * is the difference between a report someone can act on and a mystery.
 */
export function readTaskResult(json: unknown, latencyMs: number): ModelPilotTaskResult {
  const root = isObject(json) ? json : {};
  const nested = isObject(root.task) ? root.task : {};
  const pick = (...names: string[]): unknown => {
    for (const n of names) {
      if (root[n] !== undefined) return root[n];
      if (nested[n] !== undefined) return nested[n];
    }
    return undefined;
  };

  const taskId = str(pick("taskId", "task_id", "id"));
  const trajectoryId = str(pick("trajectoryId", "trajectory_id", "traceId", "trace_id"));
  const status = str(pick("status", "state"));
  const verifiedRaw = pick("verified", "isVerified");
  const cost = num(pick("actualCost", "actual_cost", "cost", "costUsd"));
  const output = pick("output", "result", "plan", "data", "content") ?? json;

  const missing: string[] = [];
  if (!taskId) missing.push("taskId");
  if (!trajectoryId) missing.push("trajectoryId");
  if (!status && verifiedRaw === undefined) missing.push("status");
  if (cost === undefined) missing.push("actualCost");

  return {
    output,
    ...(taskId ? { taskId } : {}),
    ...(trajectoryId ? { trajectoryId } : {}),
    ...(status ? { status } : {}),
    ...(typeof verifiedRaw === "boolean" ? { verified: verifiedRaw } : {}),
    ...(cost !== undefined ? { actualCost: cost } : {}),
    latencyMs,
    missing,
  };
}

/**
 * Did ModelPilot consider this task verified?
 *
 * Unknown is not yes. A service that returns no status has not told us it
 * verified anything, and the caller treats that as `unverified` — which stops a
 * device operation, by design.
 */
export function isVerified(result: ModelPilotTaskResult): boolean {
  if (typeof result.verified === "boolean") return result.verified;
  const status = result.status?.toLowerCase();
  return status === "verified" || status === "succeeded" || status === "success" || status === "completed";
}

function describeNetworkError(err: unknown, apiKey: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return `could not reach ModelPilot: ${redact(message, apiKey).slice(0, 160)}`;
}

/**
 * Strip anything credential-shaped from text that came from somewhere else.
 *
 * Two passes, because there are two ways a key gets into a message. The literal
 * key we hold, wherever it appears — a fetch error quoting the request URL is
 * the case that caught this. And any `token=` / `key=` / `secret=` /
 * `authorization=` pair, because the next leak will be a credential we were
 * never given and therefore cannot match exactly.
 */
export function redact(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join("***");
  // `bearer` is handled both as a label and as the word between a header name
  // and its value — "Authorization: Bearer sk-…" would otherwise mask the word
  // "Bearer" and print the key.
  return out.replace(
    /((?:api[_-]?key|token|secret|password|authorization)["'\s:=]+(?:bearer\s+)?|bearer\s+)([^\s"'&,}]+)/gi,
    (_whole, prefix: string) => `${prefix}***`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
