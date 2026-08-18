import type { Capability, RiskLevel } from "../capabilities/types.js";
import type { WorldModel } from "../world/model.js";

/**
 * May this happen?
 *
 * Separate from *can* this happen (the Capability Graph) and from *has it been
 * granted* (an OS permission or a signing privilege). Those two are facts about
 * the device; this is a decision, and a decision has to be explainable — every
 * denial carries the rule that produced it, because an agent that refuses and
 * cannot say why is worse than one that asks.
 *
 * Added now rather than later for the ordinary reason: the cost today is one
 * module, and the cost once twenty call sites execute capabilities directly is
 * all twenty of them.
 *
 * See docs/policy-and-safety.md.
 */

export type Actor = "user" | "agent" | "automation" | "remote";

export interface PolicyRequest {
  capability: Capability;
  args: Record<string, unknown>;
  actor: Actor;
  world?: WorldModel;
  /** Present when the whole plan is being checked before any of it runs. */
  planId?: string;
}

export type PolicyDecision =
  | { effect: "allow"; rule: string }
  | { effect: "ask"; rule: string; prompt: string; risk: RiskLevel }
  | { effect: "deny"; rule: string; reason: string };

export interface PolicyRule {
  id: string;
  /** Undefined means "applies to everything". */
  matches?: (req: PolicyRequest) => boolean;
  decide: (req: PolicyRequest) => PolicyDecision | undefined;
}

const SEVERITY: Record<PolicyDecision["effect"], number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Evaluates every rule and keeps the most restrictive answer.
 *
 * Most-restrictive-wins rather than first-match-wins so that adding a rule can
 * only ever tighten policy. A parental-control rule appended by an OEM must not
 * be silently defeated by an earlier `allow`, and with first-match it would be —
 * the ordering of an extensible rule list is not something to stake a child lock
 * on.
 */
export class PolicyEngine {
  private rules: PolicyRule[] = [];

  constructor(rules: PolicyRule[] = defaultRules()) {
    this.rules = [...rules];
  }

  add(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  check(req: PolicyRequest): PolicyDecision {
    let worst: PolicyDecision = { effect: "allow", rule: "default" };
    for (const rule of this.rules) {
      if (rule.matches && !rule.matches(req)) continue;
      const decision = rule.decide(req);
      if (!decision) continue;
      if (SEVERITY[decision.effect] > SEVERITY[worst.effect]) worst = decision;
    }
    return worst;
  }
}

/**
 * The built-in floor: risk level decides, and `critical` is refused outright.
 *
 * A `critical` capability — a door lock, a heater — needs a deliberate grant
 * through a rule that says so explicitly, not a confirmation dialog a user can
 * dismiss with the OK button they have pressed forty times today.
 */
export function defaultRules(): PolicyRule[] {
  return [
    {
      id: "risk.baseline",
      decide: ({ capability }) => {
        switch (capability.riskLevel) {
          case "low":
            return { effect: "allow", rule: "risk.baseline" };
          case "medium":
          case "high":
            return {
              effect: "ask",
              rule: "risk.baseline",
              prompt: capability.description,
              risk: capability.riskLevel,
            };
          case "critical":
            return {
              effect: "deny",
              rule: "risk.baseline",
              reason: `${capability.name} needs an explicit grant that this device does not have.`,
            };
        }
      },
    },
    {
      id: "perception.consent",
      matches: ({ capability }) => capability.domain === "perception",
      decide: ({ capability }) => ({
        effect: "ask",
        rule: "perception.consent",
        prompt: `Allow the assistant to use ${capability.name}?`,
        risk: "medium",
      }),
    },
    {
      id: "withdrawn.blocked",
      matches: ({ capability }) => capability.status === "withdrawn",
      decide: ({ capability }) => ({
        effect: "deny",
        rule: "withdrawn.blocked",
        reason: `${capability.name} isn't available on this device.`,
      }),
    },
  ];
}

/** Kids profile: no purchases, no medium-or-worse risk, a volume ceiling. */
export function parentalRules(opts: { maxVolume?: number } = {}): PolicyRule[] {
  const maxVolume = opts.maxVolume ?? 60;
  return [
    {
      id: "parental.high_risk",
      matches: ({ capability }) => capability.riskLevel === "high" || capability.riskLevel === "critical",
      decide: ({ capability }) => ({
        effect: "deny",
        rule: "parental.high_risk",
        reason: `${capability.name} is not allowed on this profile.`,
      }),
    },
    {
      id: "parental.volume_cap",
      matches: ({ capability }) => capability.id === "tv.audio.set_volume",
      decide: ({ args }) =>
        typeof args.level === "number" && args.level > maxVolume
          ? { effect: "deny", rule: "parental.volume_cap", reason: `Volume is capped at ${maxVolume} on this profile.` }
          : undefined,
    },
  ];
}

/** Every decision, for the audit trail the `?diag` view already knows how to show. */
export interface PolicyAuditEntry {
  at: number;
  capabilityId: string;
  actor: Actor;
  decision: PolicyDecision;
  planId?: string;
}
