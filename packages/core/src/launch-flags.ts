/**
 * Where launch flags (`?demo`, `?ask=`, `?llm=`, `?diag`) actually come from.
 *
 * A query string on the start page is the obvious way to parameterize a TV app
 * without rebuilding it, and it works on Android (`-e start`) and in a browser.
 * **It does not work on Tizen.** The web runtime drops the query from
 * `<content src="index.html?…"/>` in config.xml, so `location.search` is empty
 * on device — which is a miserable thing to debug, because the app boots fine
 * and simply ignores everything you asked it to do.
 *
 * So flags may also arrive as a global that the packager writes into a small
 * script beside the bundle. `launchSearch()` is the one place that knows this,
 * and every flag reader goes through it.
 */

declare const globalThis: { __AGENT_FLAGS__?: unknown } & Record<string, unknown>;

/**
 * The launch query, as a string beginning with `?` (or empty).
 *
 * A real query string wins when there is one, so a browser or an `adb`-launched
 * intent still overrides whatever was baked in at package time.
 */
export function launchSearch(): string {
  const fromUrl = typeof location !== "undefined" ? location.search : "";
  if (fromUrl && fromUrl !== "?") return fromUrl;

  const baked = typeof globalThis !== "undefined" ? globalThis.__AGENT_FLAGS__ : undefined;
  if (typeof baked !== "string" || !baked.trim()) return "";
  const trimmed = baked.trim();
  return trimmed.startsWith("?") ? trimmed : `?${trimmed}`;
}

/**
 * Parameters whose value must never be shown or logged.
 *
 * Kept deliberately wide. A flag added later called `token` or `apiKey` should
 * be covered by default, because the failure mode here is silent and permanent:
 * a credential printed once on a TV screen, or into logcat, is a credential you
 * have to rotate.
 */
const SECRET_PARAM = /^(key|api[-_]?key|token|secret|password|passwd|pass|auth|authorization)$/i;

/**
 * The launch query with credential values masked, for anything a human or a log
 * will see.
 *
 * The `?debug` status line printed the query verbatim, so launching with
 * `?key=sk-…` put a live API key on the television. Nothing redacted it, and on
 * a shipped device that key is the same for every unit of that model — one
 * screenshot and it belongs to everyone.
 *
 * Rewrites values in place rather than going through `URLSearchParams`, which
 * would reorder and re-encode the rest: this string is a debugging aid and it
 * has to keep looking exactly like what was passed in.
 */
export function redactSecrets(search: string): string {
  return search.replace(
    // `?` is excluded from the name class on purpose: without that, the `^`
    // branch matches the empty string at position 0 and swallows the leading
    // `?` into the name, so `?key=…` read as a parameter called "?key" and the
    // very first parameter — the most likely place for the key — went unmasked.
    /(^|[?&])([^=&?]+)=([^&]*)/g,
    (whole, sep: string, name: string, value: string) =>
      value && SECRET_PARAM.test(safeDecode(name)) ? `${sep}${name}=***` : whole,
  );
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * How the flags got here, for the status line. On a TV you cannot attach a
 * debugger to, "the flag never arrived" and "the flag did nothing" look
 * identical, and telling them apart cost a full debugging session once.
 */
export function launchSearchSource(): "url" | "baked" | "none" {
  const fromUrl = typeof location !== "undefined" ? location.search : "";
  if (fromUrl && fromUrl !== "?") return "url";
  return launchSearch() ? "baked" : "none";
}
