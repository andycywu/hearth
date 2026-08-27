import type { CapabilityGraph, DeviceGraph, Goal, WorldModel } from "@hearthkit/core";

/**
 * Turning a TV planning job into a ModelPilot TaskRequest — and, mostly, into
 * *less* than the agent knows.
 *
 * The World Model is designed to accumulate: sources, confidences, timestamps,
 * per-device state, occupancy, ambient light, whatever a perception source
 * contributed. Handing that to a remote service because it happens to be in
 * scope is how a living room ends up in someone's logs. So the mapper is an
 * allowlist, not a filter: a path reaches the request only if it is named here,
 * and everything else stays on the device by construction rather than by
 * remembering to strip it.
 *
 * What never leaves, and is enforced by `minimiseRoomState` plus the tests:
 * raw frames or audio (they never enter the world model in the first place —
 * see the perception gate), transcripts, people's names, conversation history,
 * device identifiers beyond the stable local id, and occupancy detail beyond a
 * coarse "someone/nobody".
 */

/** World paths that may be summarised into a remote request. */
const ALLOWED_PATHS = [
  "tv.power",
  "tv.input",
  "tv.volume",
  "tv.muted",
  "tv.pictureMode",
  "content.state",
  "audio.profile",
  "currentActivity",
] as const;

/**
 * Occupancy is coarsened rather than sent.
 *
 * "Three people are in the room" is a fact about a household; "someone is in the
 * room" is enough for every plan we have, and the difference is the whole
 * argument for minimisation. `room.childPresent` is deliberately *not* here at
 * all: it would change a plan, and it is exactly the kind of inference a family
 * would not expect to leave their television.
 */
function occupancySummary(world: WorldModel): string | undefined {
  if (!world.known("room.peopleCount") && !world.known("room.occupied")) return undefined;
  const count = world.value<number>("room.peopleCount");
  if (typeof count === "number") return count > 0 ? "occupied" : "empty";
  return world.value<boolean>("room.occupied") ? "occupied" : "empty";
}

export interface RoomSummary {
  /** Only the allowlisted TV/content facts that are actually known. */
  state: Record<string, unknown>;
  /** `occupied` | `empty`, or absent when nothing is known. */
  occupancy?: string;
  /** Device *kinds* and where they attach — never names or identifiers. */
  devices: { id: string; type: string; port?: string }[];
  /** Capability ids the plan may use. Ids only; no host or bridge detail. */
  capabilities: string[];
}

export function minimiseRoomState(
  world: WorldModel,
  devices: DeviceGraph,
  capabilities: CapabilityGraph,
): RoomSummary {
  const state: Record<string, unknown> = {};
  for (const path of ALLOWED_PATHS) {
    if (world.known(path)) state[path] = world.value(path);
  }

  const occupancy = occupancySummary(world);

  return {
    state,
    ...(occupancy ? { occupancy } : {}),
    // `id` is the local, human-chosen handle ("ps5"); the planner needs it to
    // name a target. Vendor, model and MAC stay behind.
    devices: devices.dump().map((d) => ({
      id: d.id,
      type: d.type,
      ...(d.connection.kind === "hdmi" ? { port: d.connection.port } : {}),
    })),
    capabilities: capabilities.usable().map((c) => c.id).sort(),
  };
}

// --- TaskRequest ------------------------------------------------------------

export interface TaskRequest {
  task: { instruction: string; context: string };
  strategy: string;
  requirements: {
    intelligence: string;
    capabilities: string[];
    qualitySla: number;
    maxCost: number;
    maxLatencyMs: number;
    privacy: string;
    risk: string;
    approvalMode: string;
    dataPolicy: {
      sensitivity: string;
      retentionRequirement: string;
      trainingUse: string;
      toolEgress: string;
      humanReview: string;
    };
  };
  economics: { maxTaskBudget: number; currency: string };
  verification: { type: string; requiredKeys: string[] };
}

/** The keys a TV action plan must carry. Also the local parser's contract. */
export const REQUIRED_KEYS = ["action", "target", "parameters", "expected_state", "risk"] as const;

export interface BuildTaskOptions {
  goal: Goal;
  world: WorldModel;
  devices: DeviceGraph;
  capabilities: CapabilityGraph;
  /** The user's own words, when the goal has them. Never conversation history. */
  utterance?: string;
  maxTaskBudget?: number;
  maxLatencyMs?: number;
}

/**
 * One planning step as a ModelPilot task.
 *
 * `toolEgress: "denied"` is not decoration: nothing ModelPilot does may reach
 * this television. It returns a *plan*, the local executor decides whether to
 * run it, and the local verifier decides whether it worked.
 */
export function buildTaskRequest(opts: BuildTaskOptions): TaskRequest {
  const summary = minimiseRoomState(opts.world, opts.devices, opts.capabilities);
  const goalLine = describeGoal(opts.goal);

  return {
    task: {
      instruction: [
        "You are planning one step for an AI agent embedded in a television.",
        "Return a single JSON object with exactly these keys:",
        `${REQUIRED_KEYS.join(", ")}.`,
        "`action` must be one of: set_input, set_volume, play_content, pause, power, ask_user, no_op.",
        "`target` is \"tv\" or a device id from the room summary.",
        "Use only capability ids listed in the summary. Never invent a device or a capability.",
        "Choose ask_user when the request is ambiguous, and no_op when nothing needs doing.",
        "",
        `Goal: ${goalLine}`,
        // Only when it adds something: a goal built *from* the utterance already
        // carries it, and sending the same sentence twice is both wasteful and
        // one more copy of a household's words than necessary.
        ...(opts.utterance && opts.utterance !== opts.goal.intent
          ? [`The user said: ${opts.utterance}`]
          : []),
      ].join("\n"),
      // Minimised, and serialised here so it is obvious at the call site exactly
      // what crosses the boundary.
      context: JSON.stringify(summary),
    },
    strategy: "plan_execute_verify",
    requirements: {
      intelligence: "reasoning",
      capabilities: ["planning", "tv_control"],
      qualitySla: 0.9,
      maxCost: opts.maxTaskBudget ?? 0.05,
      maxLatencyMs: opts.maxLatencyMs ?? 5000,
      privacy: "no_training",
      risk: "medium",
      approvalMode: "high_risk",
      dataPolicy: {
        sensitivity: "confidential",
        retentionRequirement: "zero",
        trainingUse: "prohibited",
        // The engine may reason; it may not reach anything in this house.
        toolEgress: "denied",
        humanReview: "allowed",
      },
    },
    economics: { maxTaskBudget: opts.maxTaskBudget ?? 0.05, currency: "USD" },
    verification: { type: "json_schema", requiredKeys: [...REQUIRED_KEYS] },
  };
}

function describeGoal(goal: Goal): string {
  const parts = [goal.intent ?? goal.id];
  for (const p of goal.desiredState) {
    if (p.equals !== undefined) parts.push(`${p.path} = ${JSON.stringify(p.equals)}`);
    else if (p.lte !== undefined) parts.push(`${p.path} <= ${p.lte}`);
    else if (p.gte !== undefined) parts.push(`${p.path} >= ${p.gte}`);
    else parts.push(p.path);
  }
  return parts.join("; ");
}
