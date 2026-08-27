/**
 * Why a ModelPilot call did not produce a usable answer.
 *
 * Typed rather than string-matched, because the caller's next move differs per
 * kind and getting it wrong is expensive in both directions: retrying a refusal
 * burns budget, and falling back silently on a *policy* refusal would defeat the
 * point of asking. `fallbackAllowed` says which is which, once, here.
 */

export type ModelPilotErrorKind =
  /** No key, no base URL, or the mode says do not call. */
  | "not_configured"
  /** Network, DNS, TLS — nothing was reached. */
  | "unreachable"
  /** The request exceeded its budget, or the caller cancelled. */
  | "timeout"
  /** 401/403 — the key is wrong, expired, or lacks scope. */
  | "unauthorized"
  /** 4xx that is not auth: the request was malformed or refused. */
  | "rejected"
  /** 5xx, or a response we could not read. */
  | "server"
  /** Reached, answered, and the answer was not a usable action plan. */
  | "unusable_output"
  /** ModelPilot itself reported the task unverified or failed. */
  | "unverified";

export class ModelPilotError extends Error {
  readonly kind: ModelPilotErrorKind;
  readonly status?: number;
  readonly taskId?: string;
  readonly trajectoryId?: string;

  constructor(
    kind: ModelPilotErrorKind,
    message: string,
    detail: { status?: number; taskId?: string; trajectoryId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ModelPilotError";
    this.kind = kind;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.taskId !== undefined) this.taskId = detail.taskId;
    if (detail.trajectoryId !== undefined) this.trajectoryId = detail.trajectoryId;
    if (detail.cause !== undefined) (this as { cause?: unknown }).cause = detail.cause;
  }

  /**
   * May the caller fall back to the local planner?
   *
   * Everything except an unusable *answer* is an availability problem, and a
   * television that stops working because a cloud service is down is a worse
   * product than one that plans locally. `unusable_output` and `unverified` are
   * different: ModelPilot was reached and said something we could not act on, so
   * acting anyway on a locally-derived plan would be substituting our judgement
   * for the answer we asked for. Those go to recovery, not to a quiet fallback.
   */
  get fallbackAllowed(): boolean {
    return this.kind !== "unusable_output" && this.kind !== "unverified";
  }
}

export function isModelPilotError(err: unknown): err is ModelPilotError {
  return err instanceof ModelPilotError;
}
