/**
 * Where the ModelPilot endpoint, key and mode come from — and, just as
 * importantly, where they do not.
 *
 * The precedence mirrors the LLM endpoint resolver so a shipped bundle can be
 * repointed without a rebuild, with one deliberate difference: **the API key is
 * never read from the launch URL.** This repo has already shipped that bug once
 * — `?key=sk-…` printed on a television's own status line, where the same key is
 * identical on every unit of the model — and a launch URL also lives in shell
 * history, in the launch intent and in logcat. Host globals and environment
 * variables are the only two ways in.
 */

export type ModelPilotMode = "off" | "shadow" | "enforce";

export interface ModelPilotConfig {
  mode: ModelPilotMode;
  baseUrl: string;
  /** Absent means "not configured" — the client must not be constructed. */
  apiKey?: string;
  timeoutMs: number;
  /** Hard ceiling handed to ModelPilot with every task, in USD. */
  maxTaskBudget: number;
  /** Where the mode came from, for the bring-up status line and telemetry. */
  source: "query" | "global" | "env" | "default";
}

export interface ResolveOptions {
  search?: string;
  globals?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  defaults?: Partial<Omit<ModelPilotConfig, "source">>;
}

export const PRODUCTION_BASE_URL = "https://modelpilot.andycywu.workers.dev";

/**
 * `timeoutMs` is 8000 because 5000 was a round number and this one is a
 * measurement.
 *
 * Twelve live plans against the production service: min 2449ms, p50 2864ms,
 * p90 3161ms, max 3272ms — comfortably inside 5s. But the *first* call of a
 * process repeatedly ran longer and two of them crossed 5000ms, which is a cold
 * Worker plus a cold provider connection, and a household's first request of the
 * evening is exactly that call. 8000 is about 2.5× p90: enough headroom for the
 * cold one, still short enough that falling back to the local planner beats
 * waiting.
 *
 * None of those numbers were taken on TV silicon, where a WebView, a bridge and
 * a weak radio all add to them. Expect to raise it again on a real device, and
 * measure rather than guess — `packages/modelpilot/scripts/latency-sample.mjs`
 * is what produced these.
 */
const DEFAULTS = {
  mode: "shadow" as ModelPilotMode,
  baseUrl: PRODUCTION_BASE_URL,
  timeoutMs: 8000,
  maxTaskBudget: 0.05,
};

/**
 * Resolve the configuration, and refuse to be half-configured.
 *
 * A missing key forces `off` rather than producing a client that fails on every
 * call: the default mode is `shadow`, which *calls the service*, and a TV that
 * quietly tries to reach a cloud endpoint it has no credential for is both noisy
 * and wrong. Configuring the key is the act that opts a device in.
 */
export function resolveModelPilotConfig(opts: ResolveOptions = {}): ModelPilotConfig {
  const params = new URLSearchParams(opts.search ?? "");
  const globals = opts.globals ?? {};
  const env = opts.env ?? {};
  const d = { ...DEFAULTS, ...opts.defaults };

  const qMode = parseMode(params.get("modelpilot"));
  const gMode = parseMode(globals["__MODELPILOT_MODE__"]);
  const eMode = parseMode(env.MODELPILOT_MODE);
  const mode = qMode ?? gMode ?? eMode ?? d.mode;
  const source: ModelPilotConfig["source"] =
    qMode ? "query" : gMode ? "global" : eMode ? "env" : "default";

  const baseUrl = trimmed(params.get("modelpilotUrl"))
    ?? trimmed(globals["__MODELPILOT_BASE_URL__"])
    ?? trimmed(env.MODELPILOT_BASE_URL)
    ?? d.baseUrl;

  // Globals and environment only. Never `params`.
  const apiKey = trimmed(globals["__MODELPILOT_API_KEY__"]) ?? trimmed(env.MODELPILOT_API_KEY);

  const timeoutMs = positive(params.get("modelpilotTimeout"))
    ?? positive(globals["__MODELPILOT_TIMEOUT_MS__"])
    ?? positive(env.MODELPILOT_TIMEOUT_MS)
    ?? d.timeoutMs;

  const maxTaskBudget = positive(globals["__MODELPILOT_MAX_COST__"])
    ?? positive(env.MODELPILOT_MAX_COST)
    ?? d.maxTaskBudget;

  return {
    // No credential, no calls — whatever the mode said.
    mode: apiKey ? mode : "off",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    ...(apiKey ? { apiKey } : {}),
    timeoutMs,
    maxTaskBudget,
    source,
  };
}

/** Why the resolved mode is `off`, when the requested one was not. */
export function offReason(opts: ResolveOptions = {}): string | undefined {
  const resolved = resolveModelPilotConfig(opts);
  if (resolved.mode !== "off") return undefined;
  if (!resolved.apiKey) return "no MODELPILOT_API_KEY configured";
  return "mode is off";
}

function parseMode(value: unknown): ModelPilotMode | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "off" || v === "shadow" || v === "enforce" ? v : undefined;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length ? t : undefined;
}

function positive(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
