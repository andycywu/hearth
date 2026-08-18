export { Agent, TurnTimeoutError, type AgentOptions, type ConfirmRequest } from "./agent/agent.js";
export {
  ToolRegistry,
  validateArgs,
  defineTool,
  ToolValidationError,
  UnknownToolError,
  type Tool,
  type ToolSpec,
  type ToolParameter,
} from "./tools/registry.js";
export { createTvTools } from "./tools/tv-tools.js";
export { probeCapabilities, type CapabilityProbe } from "./tools/capability-probe.js";
export {
  tvOk, tvFail, classifyToolError, tvResultData,
  type TvResult, type TvResultError,
} from "./tools/result.js";
export {
  runDiagnostics,
  reportToMarkdown,
  type DiagnosticsReport,
  type DiagnosticsOptions,
  type ProbeResult,
  type ProbeStatus,
} from "./diagnostics/probe.js";
export { ConversationContext } from "./memory/context.js";

// --- Living Room agent runtime (see docs/architecture.md) ---------------------
// Additive: the agent loop above is untouched. These are the state and reasoning
// tier the loop grows into — world model, capability graph, device graph,
// perception, planner, policy, skills.
export { WorldModel, type WorldModelOptions, type KnownOptions } from "./world/model.js";
export {
  W, FACT_SOURCES, sourceRank,
  type Fact, type FactSource, type Observation, type WorldEvent,
  type LivingRoomState, type Activity,
} from "./world/state.js";
export { observationsFromResult, observeResult } from "./world/from-tools.js";
export { CapabilityGraph, isTemplate } from "./capabilities/graph.js";
export {
  RISK_LEVELS,
  type Capability, type CapabilityDomain, type CapabilityStatus, type RiskLevel,
  type StatePredicate, type StateEffect, type Constraint, type Verification,
} from "./capabilities/types.js";
export {
  createTvCapabilities, createMediaCapabilities, createDevicePowerCapabilities,
} from "./capabilities/tv-capabilities.js";
export { DeviceGraph, runDiscovery, createManualSource } from "./devices/graph.js";
export type {
  DeviceNode, DeviceObservation, DeviceType, Connection, DiscoverySource, DiscoverySourceId,
} from "./devices/types.js";
export {
  applyPerception, observationsFrom,
  type PerceptionEvent, type PerceptionEventType, type PerceptionSource,
} from "./perception/events.js";
export {
  PolicyEngine, defaultRules, parentalRules,
  type Actor, type PolicyDecision, type PolicyRequest, type PolicyRule, type PolicyAuditEntry,
} from "./policy/policy.js";
export { GoalPlanner, argsFor, remainingGap, type GoalPlannerOptions } from "./planner/planner.js";
export { PlanExecutor, type PlanExecutorOptions } from "./planner/executor.js";
export { evaluate, allTrue, unsatisfied, interpolate, targetValue, type Truth } from "./planner/predicates.js";
export type {
  Goal, Plan, PlanStep, PlanOutcome, StepOutcome, StepStatus, Action, Planner,
} from "./planner/types.js";
export { SKILLS, findSkill, resolveDeviceParams, type Skill } from "./skills/scenarios.js";
export { EventBus, type AgentEvents } from "./events/bus.js";
export { launchSearch, launchSearchSource, redactSecrets, turnTimeoutFromUrl } from "./launch-flags.js";
export type {
  LlmClient,
  ChatMessage,
  ToolCall,
  CompletionRequest,
  CompletionResult,
  StreamHandlers,
} from "./llm/client.js";
export { toolsFromCapabilities, toolSpecFor, type CapabilityHandler } from "./capabilities/to-tools.js";
export { capabilitiesForPlatform, tvHandlers } from "./tools/tv-tools.js";
