import type { CapabilityGraph, DeviceGraph, Goal, WorldModel } from "@hearthkit/core";

/**
 * Turning a TV planning job into a ModelPilot request — and, mostly, into
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

// --- The request -----------------------------------------------------------

/**
 * ModelPilot's request shape is OpenAI's, because ModelPilot *is* an
 * OpenAI-compatible endpoint.
 *
 * This replaced a bespoke `TaskRequest` — `strategy`, `requirements`,
 * `economics`, `verification`, `dataPolicy` — that was written against a
 * decision-engine API the service does not have. Nothing read any of those
 * fields. They are gone rather than kept as decoration, because a declaration
 * no one enforces reads like a guarantee and is not one.
 *
 * **Where the privacy boundary actually lives**: `minimiseRoomState` above, and
 * the tests that pin it. An allowlist that cannot pass a new world path by
 * default is a mechanism; `dataPolicy: { retentionRequirement: "zero" }` in a
 * body the server ignores was a sentence. The server-side half — retention,
 * training use, tool egress — has to be implemented in ModelPilot before it can
 * be claimed anywhere.
 *
 * **`stream` is never set.** The service answers `stream: true` with HTTP 400
 * ("Streaming is not enabled in the Free-first release"), so a planner that
 * streamed would fail every call. Planning wants one JSON object anyway.
 */
export interface CompletionRequest {
  /** `"auto"` is the entire routing trigger; a model id pins one instead. */
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  /**
   * The only routing knobs the service reads (`profileRequest`). Everything
   * else about the decision — task type, complexity, token estimate — it infers
   * from the messages.
   */
  metadata: {
    quality_threshold: number;
    latency_priority: number;
    max_cost: number;
  };
}

/**
 * 0.85, and the number is load-bearing.
 *
 * A router optimises for score, and price is part of that score, so the cheapest
 * *eligible* candidate wins more often than not. A television needs a model that
 * can emit a strict JSON object on demand — a weaker one does not fail loudly,
 * it answers with prose — so the threshold has to exclude the weak end of
 * whatever catalogue the service is carrying, rather than trusting the ranking
 * to prefer capability over cost.
 *
 * The failure it buys is the good one: when nothing qualifies, the service
 * answers `422 No eligible configured model satisfies this request policy`,
 * which names a real configuration problem. The alternative is a cheap model
 * returning something plausible and unusable, which costs a round trip and looks
 * like the runtime's fault.
 *
 * The strict parser is the second line of defence: a plausible non-plan never
 * becomes a device operation. This is the first.
 */
const DEFAULT_QUALITY_THRESHOLD = 0.85;

/** A television is a latency-sensitive place. Weight, not deadline. */
const DEFAULT_LATENCY_PRIORITY = 0.7;

/** The keys a TV action plan must carry. Also the local parser's contract. */
export const REQUIRED_KEYS = ["action", "target", "parameters", "expected_state", "risk"] as const;

export interface BuildRequestOptions {
  goal: Goal;
  world: WorldModel;
  devices: DeviceGraph;
  capabilities: CapabilityGraph;
  /** The user's own words, when the goal has them. Never conversation history. */
  utterance?: string;
  /** Defaults to `"auto"`, which is what makes ModelPilot route at all. */
  model?: string;
  /** USD, sent as `metadata.max_cost`. */
  maxTaskBudget?: number;
  qualityThreshold?: number;
  latencyPriority?: number;
}

/**
 * One planning step as a chat completion.
 *
 * Two things about the wording are not cosmetic:
 *
 * 1. **"JSON" in the system message decides the routing.** The service profiles
 *    the task by scanning the joined message text in a fixed order, and
 *    `structured_extraction` matches on "json" before `reasoning` or `planning`
 *    can match on "plan". That is the profile we want — the models with a
 *    structured-extraction strength are the ones that reliably emit a strict
 *    object — but it is a coupling to someone else's regex list, so it is
 *    written down here rather than discovered later.
 * 2. **The room summary goes in the user message, once.** It is the minimised
 *    allowlist and nothing else, and keeping it in one field keeps "what
 *    crossed the boundary" answerable by looking at one string.
 */
export function buildCompletionRequest(opts: BuildRequestOptions): CompletionRequest {
  const summary = minimiseRoomState(opts.world, opts.devices, opts.capabilities);

  const system = [
    "You are planning one step for an AI agent embedded in a television.",
    "Return a single JSON object with exactly these keys:",
    `${REQUIRED_KEYS.join(", ")}.`,
    "`action` must be one of: set_input, set_volume, play_content, pause, power, ask_user, no_op.",
    "`target` is \"tv\" or a device id from the room summary.",
    "Use only capability ids listed in the room summary. Never invent a device or a capability.",
    "Choose ask_user when the request is ambiguous, and no_op when nothing needs doing.",
    "Answer with the JSON object and nothing else.",
  ].join("\n");

  const user = [
    `Goal: ${describeGoal(opts.goal)}`,
    // Only when it adds something: a goal built *from* the utterance already
    // carries it, and sending the same sentence twice is both wasteful and one
    // more copy of a household's words than necessary.
    ...(opts.utterance && opts.utterance !== opts.goal.intent
      ? [`The user said: ${opts.utterance}`]
      : []),
    `Room: ${JSON.stringify(summary)}`,
  ].join("\n");

  return {
    model: opts.model ?? "auto",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    metadata: {
      quality_threshold: opts.qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD,
      latency_priority: opts.latencyPriority ?? DEFAULT_LATENCY_PRIORITY,
      max_cost: opts.maxTaskBudget ?? 0.05,
    },
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
