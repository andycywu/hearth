import type { PlanOutcome, StepOutcome } from "./types.js";

/**
 * What happened, in a sentence a person can act on.
 *
 * Two things it must never do. It must not report `unverified` as success —
 * "switched to HDMI2" and "asked the TV to switch to HDMI2, and this device
 * can't tell me whether it did" are different claims, and only one of them is
 * true on a TV that ignored the command. And it must not hide a denial behind a
 * failure: "I didn't do that because you declined" is information, "that didn't
 * work" is a bug report the user will act on.
 *
 * It is English and mechanical, which is a known limit: the agent otherwise
 * replies in the user's language. Phrasing an outcome through the model is a
 * round trip the offline path cannot make, so for now a host that wants a
 * spoken reply in another language should pass the outcome to the LLM itself.
 */
export function summarizeOutcome(outcome: PlanOutcome): string {
  if (outcome.blocked) return outcome.blocked;

  const lines: string[] = [];
  const done = outcome.outcomes.filter((o) => o.status === "verified");
  const assumed = outcome.outcomes.filter((o) => o.status === "unverified");
  const already = outcome.outcomes.filter((o) => o.status === "satisfied");
  const denied = outcome.outcomes.filter((o) => o.status === "denied");
  const failed = outcome.outcomes.filter((o) => o.status === "failed");
  const unsupported = outcome.outcomes.filter((o) => o.status === "unsupported");
  const skipped = outcome.outcomes.filter((o) => o.status === "skipped");

  if (!outcome.plan.steps.length) {
    return outcome.plan.unreachable?.length
      ? `I can't do that on this TV: ${outcome.plan.unreachable.map((p) => p.path).join(", ")}.`
      : "Nothing to do — it was already how you wanted it.";
  }

  if (done.length) lines.push(`Done: ${names(done)}.`);
  if (already.length) lines.push(`Already set: ${names(already)}.`);
  if (assumed.length) {
    const subject = subjectFor(assumed);
    lines.push(subject
      ? `Asked ${subject} to ${names(assumed)}, but this device can't confirm it.`
      : `Asked for ${names(assumed)}, but nothing here can confirm it.`);
  }
  if (denied.length) lines.push(`Skipped ${names(denied)}: ${reason(denied)}`);
  if (unsupported.length) lines.push(`${cannot(unsupported)} ${names(unsupported)}: ${reason(unsupported)}`);
  if (failed.length) lines.push(`Couldn't ${names(failed)}: ${reason(failed)}`);
  if (skipped.length) lines.push(`${cannot(skipped)} ${names(skipped)}, so I left it.`);
  if (outcome.unmet.length && !failed.length && !denied.length && !unsupported.length) {
    lines.push(`Still not where you asked: ${outcome.unmet.map((p) => p.path).join(", ")}.`);
  }
  return lines.join(" ");
}

/** One line per step, for `?diag`, logs and the plan view. */
export function outcomeLines(outcome: PlanOutcome): string[] {
  return outcome.outcomes.map((o) =>
    `${o.step.action.capabilityId}${args(o)} — ${o.status}${o.detail ? ` (${o.detail})` : ""}`);
}

/**
 * Who the sentence is about.
 *
 * Everything here used to be the television, so "the TV" was safe to hard-code.
 * CEC changed that: `ps5.power.on` is a step about a console, and "asked the TV
 * to ps5.power.on" is both clumsy and wrong — the TV is the thing that *sent*
 * the message. Returns undefined when one plan touched several devices, because
 * a sentence with two subjects is worse than one with none.
 */
function subjectFor(outcomes: StepOutcome[]): string | undefined {
  const devices = new Set(outcomes.map((o) => deviceOf(o.step.action.capabilityId)));
  if (devices.size !== 1) return undefined;
  const device = [...devices][0]!;
  return device === "tv" ? "the TV" : `the ${device}`;
}

/** "This TV can't" is only true when the step was about the TV. */
function cannot(outcomes: StepOutcome[]): string {
  return subjectFor(outcomes) === "the TV" ? "This TV can't" : "I can't";
}

/**
 * The device a capability id names — `ps5.power.on` → `ps5`.
 *
 * The domains that are the television itself (`tv.*`) and the ones that are not
 * about a device at all (`content.*`) both answer "tv", because that is who the
 * user is talking to.
 */
function deviceOf(capabilityId: string): string {
  const prefix = capabilityId.split(".")[0] ?? "tv";
  return prefix === "content" ? "tv" : prefix;
}

function names(outcomes: StepOutcome[]): string {
  return outcomes.map((o) => `${o.step.action.capabilityId}${args(o)}`).join(", ");
}

function args(outcome: StepOutcome): string {
  const entries = Object.entries(outcome.step.action.args);
  return entries.length ? `(${entries.map(([k, v]) => `${k}=${String(v)}`).join(", ")})` : "";
}

function reason(outcomes: StepOutcome[]): string {
  return outcomes.map((o) => o.detail).filter(Boolean).join("; ") || "no reason given.";
}
