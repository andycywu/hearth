/**
 * ModelPilot adapter — a cost-aware model router, used as a planner.
 *
 * Planning and reasoning may go to ModelPilot. Device control does not: the TV,
 * CEC, IR, volume and input source stay behind the local Action Adapter, and a
 * TV task is only successful when the *local* verifier says the television ended
 * up in the expected state. See docs/modelpilot-integration.md.
 */
export { createModelPilotClient, readAnswer, redact } from "./client.js";
export type {
  ModelPilotClient, ModelPilotClientOptions, ModelPilotAnswer, CallOptions,
} from "./client.js";
export { ModelPilotError, isModelPilotError } from "./errors.js";
export type { ModelPilotErrorKind } from "./errors.js";
export {
  resolveModelPilotConfig, offReason, PRODUCTION_BASE_URL,
} from "./config.js";
export type { ModelPilotConfig, ModelPilotMode, ResolveOptions } from "./config.js";
export {
  buildCompletionRequest, minimiseRoomState, REQUIRED_KEYS,
} from "./task-mapper.js";
export type { CompletionRequest, RoomSummary, BuildRequestOptions } from "./task-mapper.js";
export { parseActionPlan, TV_ACTIONS, RISKS } from "./action-plan.js";
export type { TvActionPlan, TvAction, PlanRisk, ParseResult } from "./action-plan.js";
export { createModelPilotPlanner, toSteps } from "./planner.js";
export type { ModelPilotPlanner, ModelPilotPlannerOptions, ShadowRecord } from "./planner.js";
export { sanitizeTelemetry, createTelemetryLogger } from "./telemetry.js";
export type { ModelPilotTelemetry, TelemetrySink } from "./telemetry.js";
