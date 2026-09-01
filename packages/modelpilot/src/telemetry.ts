import type { ModelPilotMode } from "./config.js";

/**
 * One record per ModelPilot call, and nothing that could embarrass a household.
 *
 * The allowlist is the whole design again: a record is *built* from named
 * fields, so adding a room summary or a prompt to it would have to be a
 * deliberate edit here rather than an accident at a call site. What is
 * structurally absent: the API key, raw frames, raw audio, transcripts, the full
 * prompt, and the room state.
 *
 * `local_final_verification` is the field that matters most and the one an
 * engine-side dashboard cannot know: whether *this television* ended up in the
 * expected state. ModelPilot can route a call perfectly, bill for it, and the TV
 * still not have switched — the point of collecting both is to be able to see
 * that.
 */
export interface ModelPilotTelemetry {
  local_workflow_id: string;
  /** `modelpilot.request_id`. Also the key `/v1/feedback` is posted against. */
  modelpilot_request_id?: string;
  /** Which model the router chose. The interesting column once cost matters. */
  selected_model?: string;
  /** How many candidates failed before one answered. */
  fallback_count?: number;
  mode: ModelPilotMode;
  task_type: string;
  /** How the ModelPilot call itself ended. */
  status: "ok" | "unusable_output" | "error" | "skipped";
  latency_ms?: number;
  actual_cost?: number;
  /** What the priciest eligible candidate would have cost — the saving claim. */
  baseline_cost?: number;
  /**
   * ModelPilot's CST bookkeeping as reported, recorded and never acted on.
   *
   * `unverified` on every fresh completion, by design. It is here so a reader
   * can see it move once `/v1/feedback` is wired up, not so anything can gate
   * on it.
   */
  evaluation_status?: string;
  /** What the local action layer did: the plan step statuses, in order. */
  local_action_result?: string[];
  /** Whether the local verifier accepted the end state. */
  local_final_verification?: "passed" | "failed" | "not_run";
  /** Why the local path was used instead. Always set when one applies. */
  fallback_reason?: string;
  /** Response fields ModelPilot did not carry, so a gap is visible once. */
  missing_fields?: string[];
  /** Shadow mode only: did the two plans agree? */
  shadow_agreement?: "same" | "different" | "local_only" | "remote_only";
}

export type TelemetrySink = (record: ModelPilotTelemetry) => void;

/** Keys that must never appear in a telemetry record, whatever a caller passes. */
const FORBIDDEN = /api[_-]?key|authorization|bearer|prompt|room|frame|image|audio|transcript|context|instruction/i;

/**
 * Last line of defence before a record reaches a sink.
 *
 * Belt and braces over the typed shape above: a future field named `room_state`
 * would type-check nowhere, but a `Record<string, unknown>` passed through a
 * host's own logger would. Anything matching the forbidden pattern is dropped
 * and the drop is recorded, because silently removing a field a developer
 * expected to see is its own bug.
 */
export function sanitizeTelemetry(record: ModelPilotTelemetry): ModelPilotTelemetry {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (FORBIDDEN.test(key)) { dropped.push(key); continue; }
    out[key] = value;
  }
  if (dropped.length) out.dropped_fields = dropped;
  return out as unknown as ModelPilotTelemetry;
}

export function createTelemetryLogger(sink?: TelemetrySink): TelemetrySink {
  return (record) => sink?.(sanitizeTelemetry(record));
}
