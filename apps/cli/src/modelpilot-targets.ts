/**
 * Two ModelPilots, by name.
 *
 * There are two services worth testing a Hearth against: the hosted one (the Cloudflare Worker, an official key
 * issued by its owner) and a copy running on the Pi itself (the Python reference, a key generated on that box).
 * They differ in base URL and in key, and the single `MODELPILOT_API_KEY` of the first wiring could hold only one
 * at a time — switching meant editing a file and hoping the right key went with the right URL.
 *
 *   MODELPILOT_OFFICIAL_API_KEY   MODELPILOT_OFFICIAL_BASE_URL  (default: the hosted service)
 *   MODELPILOT_LOCAL_API_KEY      MODELPILOT_LOCAL_BASE_URL     (default: http://127.0.0.1:8000)
 *   MODELPILOT_TARGET             official | local   (or `--modelpilot official|local|off`)
 *
 * Each target is complete or absent: a named target without its key is not "the other one's key"; it is off, and
 * says so. `MODELPILOT_API_KEY` alone still works, unnamed, exactly as before.
 *
 * Keys are read from the environment only, like every credential here — never a flag, never printed. `status`
 * says which variable is missing, never what is in one.
 */
import type { PlanOutcome, Plan, PlannerContext, Goal } from "@hearthkit/core";
import { PRODUCTION_BASE_URL, type ModelPilotPlanner, type ShadowRecord } from "@hearthkit/modelpilot";

export const TARGET_NAMES = ["official", "local"] as const;
export type TargetName = (typeof TARGET_NAMES)[number];

export const LOCAL_BASE_URL = "http://127.0.0.1:8000";

export interface Target {
  name: TargetName;
  baseUrl: string;
  /** Absent: this target is not configured, and nothing is sent to it. */
  apiKey?: string;
  /** The variable that would configure it, for the message that says it is missing. */
  keyVariable: string;
}

type Env = Record<string, string | undefined>;

export function isTargetName(v: string | undefined): v is TargetName {
  return (TARGET_NAMES as readonly string[]).includes(v ?? "");
}

export function resolveTarget(env: Env, name: TargetName): Target {
  const prefix = `MODELPILOT_${name.toUpperCase()}_`;
  const key = env[`${prefix}API_KEY`]?.trim();
  const url = env[`${prefix}BASE_URL`]?.trim();
  return {
    name,
    baseUrl: (url || (name === "official" ? PRODUCTION_BASE_URL : LOCAL_BASE_URL)).replace(/\/+$/, ""),
    ...(key ? { apiKey: key } : {}),
    keyVariable: `${prefix}API_KEY`,
  };
}

/**
 * The environment the one-target wiring (`resolveModelPilotConfig`) understands, with this target's URL and key in
 * the unnamed slots. The key of a different target is never left behind: the unnamed ones are overwritten, or
 * removed when this target has no key — which is what makes "no key, nothing leaves the box" hold per target.
 */
export function envForTarget(env: Env, target: Target): Env {
  const { MODELPILOT_API_KEY: _k, MODELPILOT_BASE_URL: _u, ...rest } = env;
  return { ...rest, MODELPILOT_BASE_URL: target.baseUrl, ...(target.apiKey ? { MODELPILOT_API_KEY: target.apiKey } : {}) };
}

// ---- status ---------------------------------------------------------------------------------------------------

export type ProbeVerdict = "verified" | "unverified" | "failed" | "unconfigured";

export interface TargetStatus {
  name: TargetName;
  baseUrl: string;
  verdict: ProbeVerdict;
  /** One sentence, no secrets. */
  detail: string;
  latencyMs?: number;
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Ask a service three things and believe only what came back: is anything there (`/health`), does it accept this
 * key (`/v1/models` with it), how long did that take. An answer that is neither success nor a clear 401/403 is
 * `unverified` — the production Worker answered 404 to the unauthenticated probes in September, which proved
 * nothing about the key.
 */
export async function probeTarget(target: Target, o: ProbeOptions = {}): Promise<TargetStatus> {
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? Date.now;
  const base = { name: target.name, baseUrl: target.baseUrl };
  if (!target.apiKey) {
    return { ...base, verdict: "unconfigured", detail: `no ${target.keyVariable} — nothing is sent to it` };
  }
  const get = async (path: string, key?: string): Promise<{ status: number; ms: number } | { error: string }> => {
    const started = now();
    try {
      const res = await doFetch(`${target.baseUrl}${path}`, {
        ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
        signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
      });
      return { status: res.status, ms: now() - started };
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      return { error: e.name === "TimeoutError" ? "timed out" : e.cause?.code ?? (err instanceof Error ? err.message : String(err)) };
    }
  };

  const health = await get("/health");
  if ("error" in health) return { ...base, verdict: "failed", detail: `unreachable (${health.error})` };
  const models = await get("/v1/models", target.apiKey);
  if ("error" in models) return { ...base, verdict: "failed", detail: `reachable, but /v1/models: ${models.error}` };
  const alive = `/health ${health.status}`;
  if (models.status >= 200 && models.status < 300) {
    return { ...base, verdict: "verified", detail: `${alive}; key accepted (/v1/models ${models.status})`, latencyMs: models.ms };
  }
  if (models.status === 401 || models.status === 403) {
    return { ...base, verdict: "failed", detail: `${alive}; key rejected (/v1/models ${models.status})`, latencyMs: models.ms };
  }
  return { ...base, verdict: "unverified", detail: `${alive}; /v1/models answered ${models.status}, which says nothing about the key`, latencyMs: models.ms };
}

export function formatStatus(rows: readonly TargetStatus[]): string {
  const lines = rows.map((r) =>
    `  ${r.name.padEnd(9)} ${r.verdict.padEnd(12)} ${r.baseUrl}\n  ${" ".repeat(9)} ${r.detail}${r.latencyMs !== undefined ? ` · ${r.latencyMs} ms` : ""}`);
  return `ModelPilot targets\n${lines.join("\n")}\n`;
}

/** 0 when everything configured was verified (or nothing was configured); 1 when a configured target failed or could not be verified. */
export function statusExitCode(rows: readonly TargetStatus[]): number {
  return rows.some((r) => r.verdict === "failed" || r.verdict === "unverified") ? 1 : 0;
}

export async function runModelPilotStatus(
  env: Env, io: { out: (t: string) => void }, o: ProbeOptions = {},
): Promise<number> {
  const rows = await Promise.all(TARGET_NAMES.map((n) => probeTarget(resolveTarget(env, n), o)));
  io.out(formatStatus(rows));
  if (rows.every((r) => r.verdict === "unconfigured")) {
    io.out("\nNeither target has a key. Put MODELPILOT_OFFICIAL_API_KEY / MODELPILOT_LOCAL_API_KEY in ~/.config/hearth/env (0600).\n");
  }
  return statusExitCode(rows);
}

// ---- compare --------------------------------------------------------------------------------------------------

export interface CompareRecord {
  compare: true;
  goal: string;
  primary: { target: TargetName; steps: string[]; model?: string };
  other: { target: TargetName; steps: string[]; agreement: string; model?: string };
  /** Sentence for a person: same, different, or why it could not be said. */
  summary: string;
}

/**
 * A planner that does what `primary` does and, beside it, asks `other` the same question in shadow.
 *
 * Shadow is the point: `other` is built in shadow mode, so whatever it suggests is recorded and compared and never
 * returned. The agent runs the primary's plan (or the local one, if the primary is shadow too) and nothing else; a
 * slow, failed or absurd answer from the second service can cost a log line and nothing more. The comparison is
 * fired after the plan is returned and is not awaited — the room does not wait for a benchmark.
 */
export function withComparison(
  primary: { factory: (ctx: PlannerContext) => ModelPilotPlanner; report: (o: PlanOutcome) => Promise<void> },
  other: { factory: (ctx: PlannerContext) => ModelPilotPlanner },
  names: { primary: TargetName; other: TargetName },
  log: (record: CompareRecord) => void,
): { factory: (ctx: PlannerContext) => ModelPilotPlanner; report: (o: PlanOutcome) => Promise<void> } {
  return {
    report: primary.report,
    factory: (ctx) => {
      const first = primary.factory(ctx);
      const second = other.factory(ctx);
      return {
        get shadow() { return first.shadow; },
        report: (outcome) => first.report(outcome),
        async plan(goal: Goal): Promise<Plan> {
          const before = first.shadow.length;
          const plan = await first.plan(goal);
          const mine = first.shadow.length > before ? first.shadow[first.shadow.length - 1] : undefined;
          void compareOne(goal, plan, mine);
          return plan;
        },
      };

      async function compareOne(goal: Goal, plan: Plan, mine: ShadowRecord | undefined): Promise<void> {
        try {
          const before = second.shadow.length;
          await second.plan(goal);
          const theirs = second.shadow.length > before ? second.shadow[second.shadow.length - 1] : undefined;
          const steps = mine?.remoteSteps ?? plan.steps.map((s) => s.action.capabilityId);
          log(describe(goal, names, steps, mine?.selectedModel, theirs, plan.source));
        } catch (err) {
          log({
            compare: true, goal: goal.intent ?? goal.id,
            primary: { target: names.primary, steps: [] }, other: { target: names.other, steps: [], agreement: "error" },
            summary: `${names.other} could not be compared: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    },
  };
}

function describe(
  goal: Goal, names: { primary: TargetName; other: TargetName }, primarySteps: string[], primaryModel: string | undefined,
  theirs: ShadowRecord | undefined, source?: Plan["source"],
): CompareRecord {
  const text = goal.intent ?? goal.id;
  if (!theirs) {
    // A missing record is not proof nobody was asked: a call that failed records nothing either (the first live
    // comparison said "the local planner closed it" over a 502). Only a deterministic plan earns that sentence.
    const closedLocally = source === "deterministic";
    return {
      compare: true, goal: text,
      primary: { target: names.primary, steps: primarySteps, ...(primaryModel ? { model: primaryModel } : {}) },
      other: { target: names.other, steps: [], agreement: closedLocally ? "not-asked" : "no-suggestion" },
      summary: closedLocally
        ? `neither was asked: the local planner closed "${text}"`
        : `no suggestion was recorded from ${names.other} — it was not asked, or its call failed (see the ☁ lines above)`,
    };
  }
  const same = theirs.remoteSteps.join(">") === primarySteps.join(">");
  return {
    compare: true, goal: text,
    primary: { target: names.primary, steps: primarySteps, ...(primaryModel ? { model: primaryModel } : {}) },
    other: { target: names.other, steps: theirs.remoteSteps, agreement: theirs.agreement, ...(theirs.selectedModel ? { model: theirs.selectedModel } : {}) },
    summary: same ? `same plan from ${names.primary} and ${names.other}` : `${names.primary} and ${names.other} planned differently`,
  };
}
