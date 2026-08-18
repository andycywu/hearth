import { W } from "../world/state.js";
import type { DeviceGraph } from "../devices/graph.js";
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

export interface Skill {
  id: string;
  description: string;
  /** Utterance keys the host can map to this skill; not a parser. */
  triggers?: string[];
  /** Built from parameters resolved by the host (device id, title, volume). */
  goal: (params: Record<string, unknown>) => Goal;
}

export const SKILLS: Skill[] = [
  {
    id: "gaming_session",
    description: "Get the room ready to play a console",
    triggers: ["play ps5", "gaming", "打電動", "我要打 ps5"],
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
    triggers: ["movie night", "我要看電影"],
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
    triggers: ["night mode", "晚上模式"],
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
    triggers: ["quieter", "小聲一點", "turn it down"],
    // The relative intent is resolved by the host against the *world*, which is
    // the whole point of Scenario D: "a bit quieter" is only meaningful if you
    // know the current volume, and re-reading the TV to find out is the thing
    // the World Model exists to stop.
    goal: (params) => ({
      id: "volume_reduced",
      params,
      desiredState: [{ path: W.tvVolume, equals: params.level }],
    }),
  },
];

export function findSkill(id: string): Skill | undefined {
  return SKILLS.find((s) => s.id === id);
}

/**
 * Fill in a gaming goal's `{port}` from the Device Graph.
 *
 * This function is the reason the string `hdmi2` appears nowhere in the planner:
 * the port is a property of where the console happens to be plugged in today,
 * looked up at plan time, following AVR parents when there are any.
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
