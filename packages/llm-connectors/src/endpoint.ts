/**
 * Where does this build get its model from?
 *
 * Every host answers that the same way, and bring-up depends on being able to
 * repoint a *shipped* bundle at a different endpoint without a rebuild — that's
 * the difference between "edit the source, rebundle, repackage, reinstall" and
 * "relaunch with a query string". Precedence, highest first:
 *
 *   1. URL query      ?llm=http://127.0.0.1:8080/v1&model=llama3.2&key=…
 *   2. window globals __AGENT_LLM_BASE_URL__ / __AGENT_LLM_MODEL__ / __AGENT_LLM_API_KEY__
 *   3. the caller's defaults
 */

import { launchSearch } from "@tv-ai-agent/core";

export interface LlmEndpoint {
  /** Undefined when nothing configured one — the host decides what to do. */
  baseUrl?: string;
  model: string;
  apiKey?: string;
  /** Where baseUrl came from, for status lines and bring-up reports. */
  source: "query" | "global" | "default" | "none";
}

export interface ResolveLlmEndpointOptions {
  /** Query string to read. Defaults to the launch flags (`launchSearch()`). */
  search?: string;
  /** Global bag to read. Defaults to `window`. */
  globals?: Record<string, unknown>;
  defaultBaseUrl?: string;
  defaultModel?: string;
}

const DEFAULT_MODEL = "local-tv-agent";

export function resolveLlmEndpoint(opts: ResolveLlmEndpointOptions = {}): LlmEndpoint {
  const search = opts.search ?? launchSearch();
  const globals = opts.globals ?? (typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : {});
  const params = new URLSearchParams(search);

  const qBase = trimmed(params.get("llm"));
  const gBase = trimmed(globals["__AGENT_LLM_BASE_URL__"]);
  const dBase = trimmed(opts.defaultBaseUrl);

  const baseUrl = qBase ?? gBase ?? dBase;
  const source: LlmEndpoint["source"] =
    qBase ? "query" : gBase ? "global" : dBase ? "default" : "none";

  const model =
    trimmed(params.get("model")) ??
    trimmed(globals["__AGENT_LLM_MODEL__"]) ??
    trimmed(opts.defaultModel) ??
    DEFAULT_MODEL;

  // A key may be needed for a cloud gateway; never invent one.
  const apiKey = trimmed(params.get("key")) ?? trimmed(globals["__AGENT_LLM_API_KEY__"]);

  return { ...(baseUrl ? { baseUrl } : {}), model, ...(apiKey ? { apiKey } : {}), source };
}

function trimmed(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}
