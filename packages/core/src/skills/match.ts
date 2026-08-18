import { SKILLS, type Skill } from "./scenarios.js";

/**
 * Which scenario, if any, an utterance is asking for.
 *
 * **A stopgap, and labelled as one.** Real intent understanding is the LLM
 * planner's job (roadmap task 9); this exists so the P0 scenarios can be driven
 * from a host with no model at all, which is what makes them demonstrable
 * offline and testable in CI. It matches fragments and pulls out the one or two
 * parameters those scenarios need, and it deliberately does not try to be
 * general: an utterance it does not recognise falls through to the normal chat
 * path, which is the right outcome for everything it cannot handle.
 */

export interface SkillMatch {
  skill: Skill;
  params: Record<string, unknown>;
}

const HDMI = /\bhdmi\s*-?\s*([1-4])\b/i;
const STEP = /\b(\d{1,3})\b/;

export function matchSkill(text: string): SkillMatch | undefined {
  const input = text.trim().toLowerCase();
  if (!input) return undefined;

  for (const skill of SKILLS) {
    if (!skill.triggers?.some((t) => input.includes(t.toLowerCase()))) continue;
    return { skill, params: paramsFor(skill.id, input) };
  }
  return undefined;
}

function paramsFor(skillId: string, input: string): Record<string, unknown> {
  switch (skillId) {
    case "switch_input": {
      const port = HDMI.exec(input);
      return port ? { source: `hdmi${port[1]}` } : {};
    }
    case "gaming_session":
      return { device: /xbox/.test(input) ? "xbox" : "ps5" };
    case "quieter":
    case "louder": {
      // "turn it down by 5". A bare number in "night mode 20" would be a
      // different parameter, which is why this only applies to these two.
      const step = STEP.exec(input);
      return step ? { step: Number(step[1]) } : {};
    }
    default:
      return {};
  }
}

/**
 * Does this utterance name a scenario we can plan, with everything it needs?
 *
 * `switch_input` without a port is the case worth having: "switch the input" is
 * a recognisable intent and an unplannable goal, and falling through to chat
 * lets the model ask which one rather than the agent guessing HDMI1.
 */
export function isPlannable(match: SkillMatch): boolean {
  return match.skill.id !== "switch_input" || typeof match.params.source === "string";
}
