/**
 * One shape for every TV tool result.
 *
 * Before this, "the TV can't do that" was a thrown `Error` whose message began
 * with `"Not supported: "` — a convention nothing parsed at runtime. Only the
 * adapter tests asserted it. The agent caught any tool error and handed the
 * model `{ error: "<english prose>" }`, so *unsupported* (this firmware lacks the
 * capability), *failed* (it tried and something went wrong) and *offline* (no
 * route) were indistinguishable to everything except a reader of English.
 *
 * That distinction matters to the model's next move: an unsupported tool should
 * never be retried and the user should be told plainly, a failure might be worth
 * one retry, and offline means say so rather than blame the TV.
 *
 * Success keeps carrying whatever the tool actually read, under `data`. The
 * envelope only adds the discriminant — it does not flatten the payload, because
 * `{ volume: 30, muted: false }` is the useful part.
 */

import { isTvUnsupported } from "@hearthkit/platform-api";
import { UnknownToolError } from "./registry.js";

export type TvResultError = "unsupported" | "failed" | "offline";

export type TvResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: TvResultError; message: string };

export function tvOk(data?: unknown): TvResult {
  return data === undefined ? { ok: true } : { ok: true, data };
}

export function tvFail(error: TvResultError, message: string): TvResult {
  return { ok: false, error, message };
}

/**
 * Classify a thrown tool error.
 *
 * Adapters keep throwing — they were not changed for this, so the working AOSP
 * path is untouched — and the classification happens once, here, at the boundary
 * where a result becomes something the model reads.
 */
export function classifyToolError(err: unknown): TvResult {
  const message = err instanceof Error ? err.message : String(err);

  // A tool that isn't registered cannot run on this device, so this is
  // `unsupported`, not a failure. It arises two ways and the answer suits both:
  // a model inventing a tool name should be told it does not exist rather than
  // invited to retry, and a tool the agent *withdrew* — because this firmware
  // can't back it — must not come back as "that didn't work". Withdrawal made
  // the second case reachable: on the Tizen emulator `set volume to 30` reported
  // "That didn't work: Unknown tool: set_volume" when the truth was that this TV
  // has no audio API.
  if (err instanceof UnknownToolError) {
    return tvFail("unsupported", `${err.tool} isn't available on this device`);
  }
  // The typed signal, which is what every adapter in this repo throws.
  if (isTvUnsupported(err)) {
    return tvFail("unsupported", message.replace(/^Not supported:\s*/i, ""));
  }
  // Prefix fallback, for an adapter written outside this repo that only follows
  // the old convention. Best-effort by nature: a reworded prefix silently
  // downgrades to `failed`, which is exactly why ours no longer rely on it.
  if (/^Not supported\b/i.test(message)) {
    return tvFail("unsupported", message.replace(/^Not supported:\s*/i, ""));
  }
  // A fetch that never reached anything looks like this in every TV WebView.
  // Deliberately narrow: a 500 from a reachable server is a failure, not offline.
  if (/failed to fetch|network ?error|net::ERR|offline|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return tvFail("offline", message);
  }
  return tvFail("failed", message);
}

/**
 * The payload inside a successful envelope, or the value itself if it isn't one.
 *
 * For consumers that read tool results and predate the envelope — the offline
 * scripted brain does, and a real model does not need this at all.
 */
export function tvResultData(value: unknown): unknown {
  if (value && typeof value === "object" && (value as { ok?: unknown }).ok === true) {
    return (value as { data?: unknown }).data;
  }
  return value;
}
