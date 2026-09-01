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
  /** 401/403 — the key is wrong, revoked, or its subscription is inactive. */
  | "unauthorized"
  /** 429 — the tenant's monthly request limit is spent. */
  | "rate_limited"
  /**
   * 4xx that is neither auth nor quota. Two real cases, and they read alike:
   * a malformed request, and `422 No eligible configured model satisfies this
   * request policy` — which usually means the tenant configured no provider
   * credential, or the quality threshold excluded the whole catalogue.
   */
  | "rejected"
  /** 5xx, or a response we could not read. */
  | "server"
  /** Reached, answered, and the answer was not a usable action plan. */
  | "unusable_output";

export class ModelPilotError extends Error {
  readonly kind: ModelPilotErrorKind;
  readonly status?: number;
  /** `modelpilot.request_id`, when the failure came with one. */
  readonly requestId?: string;

  constructor(
    kind: ModelPilotErrorKind,
    message: string,
    detail: { status?: number; requestId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ModelPilotError";
    this.kind = kind;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.requestId !== undefined) this.requestId = detail.requestId;
    if (detail.cause !== undefined) (this as { cause?: unknown }).cause = detail.cause;
  }

  /**
   * May the caller fall back to the local planner?
   *
   * Everything except an unusable *answer* is an availability problem, and a
   * television that stops working because a cloud service is down, or out of
   * quota, is a worse product than one that plans locally. `unusable_output` is
   * different: ModelPilot was reached and said something we could not act on, so
   * acting anyway on a locally-derived plan would be substituting our judgement
   * for the answer we asked for. That goes to recovery, not to a quiet fallback.
   *
   * There used to be an `unverified` kind here too, for a task ModelPilot
   * reported as unverified. It was a misreading: the service's
   * `evaluation_status` is CST bookkeeping that starts at `unverified` on every
   * completion and only changes when a verifier posts to `/v1/feedback`. Gating
   * on it meant enforce mode refused every answer it ever received.
   */
  get fallbackAllowed(): boolean {
    return this.kind !== "unusable_output";
  }
}

export function isModelPilotError(err: unknown): err is ModelPilotError {
  return err instanceof ModelPilotError;
}
