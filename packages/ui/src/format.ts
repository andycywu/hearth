/** Pure, view-agnostic formatting helpers (unit-testable without a DOM). */

/** Human-readable one-liner for a tool call, e.g. `set_volume(level=30)`. */
export function formatToolCall(name: string, args: unknown): string {
  const a = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const parts = Object.entries(a).map(([k, v]) => `${k}=${stringify(v)}`);
  return `${name}(${parts.join(", ")})`;
}

/** Truncate long strings for the 10-foot display. */
export function truncate(text: string, max = 120): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}
