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
 * How the flags got here, for the status line. On a TV you cannot attach a
 * debugger to, "the flag never arrived" and "the flag did nothing" look
 * identical, and telling them apart cost a full debugging session once.
 */
export function launchSearchSource(): "url" | "baked" | "none" {
  const fromUrl = typeof location !== "undefined" ? location.search : "";
  if (fromUrl && fromUrl !== "?") return "url";
  return launchSearch() ? "baked" : "none";
}
