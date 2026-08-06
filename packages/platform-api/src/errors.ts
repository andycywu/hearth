/**
 * "This TV can't do that" — as a type, not a sentence.
 *
 * Adapters used to say it by throwing a plain `Error` whose message began with
 * `"Not supported: "`, and one place upstream classified it by matching that
 * prefix. It worked, and it was one typo from silently not working: rewording
 * the message to `"Unsupported: "` compiles, passes review, and downgrades the
 * result from *unsupported* to *failed*. The user then gets "that didn't work,
 * try again" for something that will never work, and nothing anywhere reports a
 * problem.
 *
 * Throwing this instead makes the intent checkable by the compiler.
 */

/** The marker, kept in one place so the class and the guard can't disagree. */
const TV_UNSUPPORTED = "unsupported" as const;

export class TvUnsupportedError extends Error {
  /**
   * Structural marker rather than relying on `instanceof` alone.
   *
   * `instanceof` compares constructor identity, so it answers false when two
   * copies of this module end up in one bundle — which is exactly the silent
   * misclassification this class exists to prevent. A property survives that.
   */
  readonly tvError = TV_UNSUPPORTED;

  /**
   * @param what Why, in the user's terms — "setInputSource needs a platform
   *   signature", not "E_NOSYS". It reaches the screen.
   */
  constructor(what: string) {
    // The `Not supported: ` prefix stays in the message for logs and for the
    // string fallback that still covers adapters outside this repo.
    super(`Not supported: ${what}`);
    this.name = "TvUnsupportedError";
  }
}

/** Whether a thrown value means the platform genuinely cannot do this. */
export function isTvUnsupported(err: unknown): err is TvUnsupportedError {
  return typeof err === "object" && err !== null
    && (err as { tvError?: unknown }).tvError === TV_UNSUPPORTED;
}
