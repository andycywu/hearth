import { W } from "../world/state.js";
import type { DeviceGraph } from "../devices/graph.js";
import type { WorldModel } from "../world/model.js";
import type { Goal } from "../planner/types.js";

/**
 * Scenarios, as declared goals rather than scripts.
 *
 * "我要打 PS5" is a *situation the user wants to be in*, not a sequence of
 * commands, and writing it as a sequence is what makes an agent brittle: the
 * script that switches to HDMI2 is wrong the moment the console moves to HDMI3,
 * wrong on a TV whose input list differs, and wrong again when the console is
 * already on. A goal survives all three, because the planner re-derives the
 * steps from the world it finds.
 *
 * The hard rule: **no skill contains platform-specific code.** If one ever needs
 * to, the Capability Graph is missing an entry — that is the diagnosis, and
 * adding the entry is the fix.
 *
 * See docs/agent-planner.md.
 */

export interface SkillContext {
  world: WorldModel;
  devices: DeviceGraph;
  /**
   * Look something up before planning — the *perception* step of the loop.
   *
   * "A bit quieter" cannot be turned into a goal without knowing the current
   * volume, and the honest way to get it is to look, once, rather than to guess
   * a number or to make the planner carry relative arithmetic it has no business
   * knowing about.
   */
  observe(capabilityId: string): Promise<void>;
}

export interface Skill {
  id: string;
  description: string;
  /** Utterance fragments a host matcher can key on; not a parser. */
  triggers?: string[];
  /**
   * Turn raw parameters into the ones the goal needs, looking at the world and
   * the device graph. Returning `undefined` means "I cannot express this as a
   * goal here" — the agent then says why instead of planning something wrong.
   */
  resolve?: (params: Record<string, unknown>, ctx: SkillContext) => Promise<Record<string, unknown> | undefined>;
  goal: (params: Record<string, unknown>) => Goal;
  /** Shown when `resolve` declines. */
  blocked?: string;
}

export const SKILLS: Skill[] = [
  {
    id: "switch_input",
    description: "Show what is on another input",
    triggers: ["hdmi", "switch input", "切到", "切換輸入"],
    goal: (params) => ({
      id: "input_switched",
      params,
      desiredState: [{ path: W.tvInput, equals: "{source}" }],
    }),
  },
  {
    id: "gaming_session",
    description: "Get the room ready to play a console",
    triggers: ["ps5", "playstation", "xbox", "打電動", "打 ps5", "gaming"],
    blocked: "I don't know where that console is plugged in.",
    // The port is a property of where the console happens to be plugged in
    // today, so it is looked up now rather than written into the goal — which is
    // why moving the console to another HDMI port changes the plan and changes
    // no code.
    resolve: async (params, ctx) => {
      const query = String(params.device ?? "ps5");
      const found = ctx.devices.find(query)[0];
      if (!found) return undefined;
      const port = ctx.devices.inputPortFor(found.id);
      if (!port) return undefined;
      return { ...params, device: found.id, port };
    },
    goal: (params) => ({
      id: "gaming_session_active",
      params,
      desiredState: [
        { path: W.device(String(params.device ?? "console"), "power"), equals: "on" },
        { path: W.tvInput, equals: "{port}" },
      ],
      optional: [
        { path: W.tvPictureMode, equals: "game" },
        { path: W.audioProfile, equals: "game" },
      ],
      preferredOrder: [
        "content.pause",
        `${String(params.device ?? "console")}.power.on`,
        "tv.input.switch",
        "tv.display.set_picture_mode",
        "tv.audio.set_profile",
      ],
    }),
  },
  {
    id: "movie_night",
    description: "Set the room up for a film",
    triggers: ["movie night", "看電影", "我要看電影", "watch a film"],
    goal: (params) => ({
      id: "movie_night_active",
      params,
      desiredState: [{ path: W.contentState, equals: "playing" }],
      optional: [
        { path: W.tvPictureMode, equals: "movie" },
        { path: W.audioProfile, equals: "cinema" },
        { path: "room.lights", equals: "dim" },
      ],
    }),
  },
  {
    id: "night_mode",
    description: "Quieter and dimmer, for late viewing",
    triggers: ["night mode", "晚上模式", "夜間模式"],
    goal: (params) => ({
      id: "night_mode_active",
      params,
      desiredState: [{ path: W.tvVolume, lte: Number(params.maxVolume ?? 20) }],
      optional: [
        { path: W.tvPictureMode, equals: "eco" },
        { path: W.audioProfile, equals: "night" },
      ],
    }),
  },
  {
    id: "quieter",
    description: "Turn the volume down relative to where it is now",
    triggers: ["quieter", "小聲", "小聲一點", "turn it down", "轉小聲"],
    blocked: "I can't tell how loud it is right now.",
    resolve: async (params, ctx) => {
      // Look only if we do not already know — the whole point of the World Model
      // is that the second "a bit quieter" in a row costs nothing.
      if (!ctx.world.known(W.tvVolume)) await ctx.observe("tv.audio.get_volume");
      const current = ctx.world.value<number>(W.tvVolume);
      if (typeof current !== "number") return undefined;
      const step = Number(params.step ?? 10);
      return { ...params, level: Math.max(0, Math.min(100, Math.round(current - step))) };
    },
    goal: (params) => ({
      id: "volume_reduced",
      params,
      // `lte`, not `equals`: "quieter" is satisfied by landing at or below the
      // level we computed, and on a real TV that distinction is the difference
      // between success and a lie. Android maps 0-100 onto 15 volume steps, so
      // asking for 23 sets step 3 and reads back 20 — with `equals` the step
      // verified and the *goal* still reported "still not where you asked" about a
      // volume it had just successfully changed. A tolerance on the goal was the
      // wrong fix: it made a small change a no-op, because the goal was already
      // within tolerance before anything happened.
      desiredState: [{ path: W.tvVolume, lte: Number(params.level) }],
    }),
  },
  {
    id: "louder",
    description: "Turn the volume up relative to where it is now",
    triggers: ["louder", "大聲", "大聲一點", "turn it up", "轉大聲"],
    blocked: "I can't tell how loud it is right now.",
    resolve: async (params, ctx) => {
      if (!ctx.world.known(W.tvVolume)) await ctx.observe("tv.audio.get_volume");
      const current = ctx.world.value<number>(W.tvVolume);
      if (typeof current !== "number") return undefined;
      const step = Number(params.step ?? 10);
      return { ...params, level: Math.max(0, Math.min(100, Math.round(current + step))) };
    },
    goal: (params) => ({
      id: "volume_raised",
      params,
      // Mirror of `quieter`: at or above the level asked for.
      desiredState: [{ path: W.tvVolume, gte: Number(params.level) }],
    }),
  },
];

export function findSkill(id: string): Skill | undefined {
  return SKILLS.find((s) => s.id === id);
}

/**
 * Fill in a device's current HDMI port from the Device Graph.
 *
 * Kept exported because it is the clearest demonstration of the rule: the string
 * `hdmi2` appears nowhere in the planner or in any goal, it is looked up, and
 * AVR parents are followed on the way.
 */
export function resolveDeviceParams(
  devices: DeviceGraph,
  query: string,
): { device: string; port?: string } | undefined {
  const found = devices.find(query)[0];
  if (!found) return undefined;
  const port = devices.inputPortFor(found.id);
  return { device: found.id, ...(port ? { port } : {}) };
}
