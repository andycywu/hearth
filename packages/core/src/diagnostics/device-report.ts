import type { PlatformProvider, DeviceInfo } from "@hearthkit/platform-api";
import type { Agent } from "../agent/agent.js";
import { runDiagnostics, type DiagnosticsReport } from "./probe.js";
import { deviceTreeText } from "../devices/report.js";
import { summarizeOutcome } from "../planner/report.js";
import type { StepStatus } from "../planner/types.js";

/**
 * Everything the Hearth Report wants from one television, collected in one pass
 * and formatted so it can be pasted without editing.
 *
 * The contribution path this exists for: someone owns a TV nobody here does,
 * runs one command, and pastes the result. Anything they have to reformat by
 * hand is a step where the report does not get sent — so the output is the final
 * artefact, not raw data someone else has to interpret.
 *
 * The section that matters most is the one an adapter cannot produce about
 * itself: **what accepted a command and then did nothing.** A device that
 * answers `ok` and changes nothing is invisible to every self-report, and it is
 * only visible here because each plan step is verified by reading the device
 * back.
 */

export interface ReportedStep {
  capability: string;
  args: Record<string, unknown>;
  status: StepStatus;
  detail?: string;
}

export interface ReportedIntent {
  intent: string;
  goal: string;
  planned: ReportedStep[];
  outcomes: ReportedStep[];
  /** Goal predicates nothing on this device can produce. */
  unreachable: string[];
  achieved: boolean;
  summary: string;
  /** Set when the utterance was not plan work at all — it went to conversation. */
  conversational?: boolean;
}

export interface DeviceReport {
  generatedAt: string;
  device: DeviceInfo;
  diagnostics: DiagnosticsReport;
  capabilities: { id: string; status: string; provider: string; reason?: string }[];
  room: string;
  intents: ReportedIntent[];
  /** Steps whose read-back disagreed — the accept-and-ignore signature. */
  acceptedButDidNothing: ReportedStep[];
  notes: string[];
}

export interface CollectOptions {
  agent: Agent;
  platform: PlatformProvider;
  /** Utterances to put through goal mode. Defaults to the four P0 scenarios. */
  intents?: string[];
  /** Let the diagnostics probe write (volume round-trip, a key press). */
  allowWrites?: boolean;
  notes?: string[];
  now?: () => Date;
}

/** The four P0 scenarios, which is what a first report should cover. */
export const DEFAULT_INTENTS = ["switch to hdmi2", "play ps5", "turn it down", "movie night"];

export async function collectDeviceReport(opts: CollectOptions): Promise<DeviceReport> {
  const { agent, platform } = opts;
  const now = opts.now ?? (() => new Date());

  const diagnostics = await runDiagnostics(platform, { allowWrites: opts.allowWrites ?? false });

  const intents: ReportedIntent[] = [];
  for (const intent of opts.intents ?? DEFAULT_INTENTS) {
    const outcome = await agent.pursueIntent(intent);
    if (!outcome) {
      // Not plan work. Recorded rather than skipped: "this phrasing went to
      // conversation" is a real answer about the matcher, and a reader comparing
      // two devices needs to know the difference between "it planned nothing"
      // and "it never planned".
      intents.push({
        intent, goal: "(conversation)", planned: [], outcomes: [],
        unreachable: [], achieved: false, summary: "not plan work — handled as conversation",
        conversational: true,
      });
      continue;
    }
    intents.push({
      intent,
      goal: outcome.plan.goal.id,
      planned: outcome.plan.steps.map((s) => ({
        capability: s.action.capabilityId, args: s.action.args, status: "satisfied" as StepStatus,
      })),
      outcomes: outcome.outcomes.map(toReported),
      unreachable: (outcome.plan.unreachable ?? []).map((p) => p.path),
      achieved: outcome.achieved,
      summary: outcome.blocked ?? summarizeOutcome(outcome),
    });
  }

  const capabilities = agent.capabilities.list().map((c) => ({
    id: c.id,
    status: c.status,
    provider: c.provider,
    ...(agent.capabilities.reasons.get(c.id) ? { reason: agent.capabilities.reasons.get(c.id)! } : {}),
  }));

  return {
    generatedAt: now().toISOString(),
    device: platform.device,
    diagnostics,
    capabilities,
    room: deviceTreeText(agent.devices),
    intents,
    // `failed` means the call was accepted and the read-back disagreed. That is
    // the whole point of collecting this: it is the one class of defect a device
    // will never admit to.
    acceptedButDidNothing: intents.flatMap((i) => i.outcomes.filter((o) => o.status === "failed")),
    notes: opts.notes ?? [],
  };
}

function toReported(outcome: { step: { action: { capabilityId: string; args: Record<string, unknown> } }; status: StepStatus; detail?: string }): ReportedStep {
  return {
    capability: outcome.step.action.capabilityId,
    args: outcome.step.action.args,
    status: outcome.status,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

/**
 * The report as a Hearth Report section — markdown, ready to paste into an issue
 * or straight into `docs/platform/capability-matrix.md`.
 */
export function deviceReportToMarkdown(report: DeviceReport): string {
  const d = report.device;
  const out: string[] = [];

  out.push(`## ${d.model || "Unknown device"} — ${d.os} ${d.osVersion} (reported ${report.generatedAt.slice(0, 10)})`);
  out.push("");
  out.push(`**Device**: ${d.model || "?"} · ${d.os} ${d.osVersion} · soc=${d.soc || "unknown"}`);
  out.push("");

  const s = report.diagnostics.summary;
  out.push(`**Capability probe**: ${s.ok} ok · ${s.unsupported} unsupported · ${s.error} error · ${s.skipped} skipped`);
  out.push("");
  out.push("| Capability | Status | Detail |");
  out.push("|---|---|---|");
  for (const r of report.diagnostics.results) {
    out.push(`| ${r.capability} | ${icon(r.status)} | ${r.detail ?? ""} |`);
  }
  out.push("");

  const withdrawn = report.capabilities.filter((c) => c.status === "withdrawn");
  if (withdrawn.length) {
    out.push("**Withdrawn on this device** — offered by the catalogue, refused by the hardware:");
    out.push("");
    for (const c of withdrawn) out.push(`- \`${c.id}\` — ${c.reason ?? "reported unsupported"}`);
    out.push("");
  }

  out.push("### Goal mode");
  out.push("");
  if (!report.intents.length) {
    out.push("_Not run._");
  }
  for (const intent of report.intents) {
    out.push(`**“${intent.intent}”** → \`${intent.goal}\``);
    out.push("");
    if (intent.conversational) {
      out.push("- not plan work on this build — handled as conversation");
    } else if (!intent.outcomes.length) {
      out.push(`- nothing runnable${intent.unreachable.length ? ` — out of reach: ${intent.unreachable.join(", ")}` : ""}`);
    } else {
      for (const o of intent.outcomes) {
        out.push(`- \`${o.capability}(${args(o.args)})\` — **${o.status}**${o.detail ? ` — ${o.detail}` : ""}`);
      }
      if (intent.unreachable.length) out.push(`- out of reach: ${intent.unreachable.join(", ")}`);
    }
    out.push(`- _${intent.summary}_`);
    out.push("");
  }

  out.push("### Did anything accept a command and then do nothing?");
  out.push("");
  if (report.acceptedButDidNothing.length) {
    out.push("**Yes** — these were accepted and the read-back disagreed:");
    out.push("");
    for (const o of report.acceptedButDidNothing) {
      out.push(`- \`${o.capability}(${args(o.args)})\` — ${o.detail ?? "the device did not end up in the expected state"}`);
    }
    out.push("");
    out.push("This is the most useful row in the report: no adapter can report it about itself.");
  } else {
    out.push("Nothing detected in this run. (Only actions with a read-back can answer this;");
    out.push("anything reported `unverified` above is a case where the device cannot say.)");
  }
  out.push("");

  out.push("### The room");
  out.push("");
  out.push("```");
  out.push(report.room);
  out.push("```");
  out.push("");

  if (report.notes.length) {
    out.push("### Notes");
    out.push("");
    for (const n of report.notes) out.push(`- ${n}`);
    out.push("");
  }

  return out.join("\n");
}

function icon(status: string): string {
  return status === "ok" ? "✅"
    : status === "unsupported" ? "⛔"
    : status === "error" ? "⚠️"
    : "⏭️";
}

function args(value: Record<string, unknown>): string {
  return Object.entries(value).map(([k, v]) => `${k}=${String(v)}`).join(", ");
}
