import { defineTool, type Tool } from "@hearthkit/core";
import { LIMITS, validateManifest, type SkillManifest } from "./schema.js";

export interface ManifestToolOptions {
  /**
   * Origins this manifest may call, e.g. `["https://api.open-meteo.com"]`.
   * **Required** — the host owns the allowlist and a manifest cannot widen it.
   * `"loopback"` additionally permits http://127.0.0.1 and http://localhost,
   * for a service running on the TV itself.
   */
  allowOrigins: string[];
  /** Injected by tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Applies when the manifest doesn't set one. Default 8000ms. */
  defaultTimeoutMs?: number;
}

/**
 * Interpret a manifest as a `Tool`. No code from the manifest is executed — it
 * only chooses a URL from an allowlisted origin, fills in validated arguments,
 * and reads paths out of the JSON that comes back.
 *
 * See docs/adr/0002-declarative-skill-manifests.md for why each restriction is
 * here; the short version is that a manifest describes an outbound request
 * carrying model-generated arguments, and that deserves a narrow surface.
 */
export function createManifestTool(
  manifest: SkillManifest,
  opts: ManifestToolOptions,
): Tool<Record<string, unknown>, Record<string, unknown>> {
  const check = validateManifest(manifest);
  if (!check.ok) {
    throw new Error(`invalid skill manifest: ${check.errors.join("; ")}`);
  }
  if (!opts.allowOrigins?.length) {
    throw new Error(
      `skill "${manifest.name}": allowOrigins is required — the host decides which origins a manifest may call`,
    );
  }

  // The host is fixed, so this is answerable now rather than on first call.
  const problem = originProblem(manifest.request.url, opts.allowOrigins);
  if (problem) throw new Error(`${manifest.name}: ${problem}`);

  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const method = manifest.request.method ?? "GET";
  const timeoutMs = manifest.request.timeoutMs ?? opts.defaultTimeoutMs ?? 8000;
  // A side effect always gets a human in the loop, whatever the manifest says.
  const confirm = method === "GET" ? manifest.confirm === true : true;

  return defineTool<Record<string, unknown>, Record<string, unknown>>(
    {
      name: manifest.name,
      description: manifest.description,
      parameters: manifest.parameters,
      ...(confirm ? { confirm: true } : {}),
    },
    async (args) => {
      // `args` is already schema-validated by the registry; interpolation can
      // therefore only ever inject declared parameters, never conversation text.
      const url = fillTemplate(manifest.request.url, args, { encode: true });
      assertAllowed(url, opts.allowOrigins, manifest.name);

      // Fill string values in place. Interpolating into the *serialized* JSON
      // would both mis-parse placeholders across the JSON's own braces and risk
      // an injected quote changing the document's shape.
      const body = manifest.request.body ? fillValues(manifest.request.body, args) : undefined;

      const controller = typeof AbortController === "function" ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      try {
        const res = await doFetch(url, {
          method,
          // Deliberately no headers from the manifest — a skill must not be able
          // to attach credentials to a request of its choosing.
          ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!res.ok) throw new Error(`${manifest.name}: the service answered HTTP ${res.status}`);

        const text = await res.text();
        if (text.length > LIMITS.responseBytes) {
          throw new Error(`${manifest.name}: the response was too large to read`);
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`${manifest.name}: the service didn't return JSON`);
        }

        const out: Record<string, unknown> = {};
        for (const [field, path] of Object.entries(manifest.response)) {
          const value = readPath(json, path);
          if (value !== undefined) out[field] = value;
        }
        if (Object.keys(out).length === 0) {
          throw new Error(`${manifest.name}: the response had none of the fields this skill expects`);
        }
        return out;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          throw new Error(`${manifest.name}: no answer within ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  );
}

/** Replace `{param}` with the argument's value. Unknown names are left alone. */
function fillTemplate(
  template: string,
  args: Record<string, unknown>,
  { encode }: { encode: boolean },
): string {
  return template.replace(/\{([^}]*)\}/g, (whole, rawName: string) => {
    const name = rawName.trim();
    if (!(name in args)) return whole;
    const value = String(args[name] ?? "");
    return encode ? encodeURIComponent(value) : value;
  });
}

/** Same substitution, applied to every string inside a structure. */
function fillValues(value: unknown, args: Record<string, unknown>): unknown {
  if (typeof value === "string") return fillTemplate(value, args, { encode: false });
  if (Array.isArray(value)) return value.map((v) => fillValues(v, args));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fillValues(v, args)]),
    );
  }
  return value;
}

/**
 * Why this URL may not be called, or null if it may.
 *
 * The manifest's host is fixed (the schema rejects a placeholder there), so
 * this answers the same for a template as for the filled URL — which lets a
 * host find an unusable skill at load time instead of mid-conversation.
 */
export function originProblem(url: string, allowOrigins: string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a valid URL`;
  }
  const isLoopback = parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]");

  if (allowOrigins.includes("loopback") && isLoopback) return null;
  if (parsed.protocol !== "https:" && !isLoopback) {
    return `refusing plain http to ${parsed.origin} — https, or loopback for an on-device service`;
  }
  if (allowOrigins.includes(parsed.origin)) return null;

  return `${parsed.origin} is not in the host's allowlist (${allowOrigins.join(", ")})`;
}

function assertAllowed(url: string, allowOrigins: string[], skill: string): void {
  const problem = originProblem(url, allowOrigins);
  if (problem) throw new Error(`${skill}: ${problem}`);
}

/** `a.b`, `a[0].b` — no expressions, so no evaluator. */
export function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const step of path.match(/[A-Za-z_$][\w$]*|\[\d+\]/g) ?? []) {
    if (current === null || current === undefined) return undefined;
    if (step.startsWith("[")) {
      const index = Number(step.slice(1, -1));
      if (!Array.isArray(current)) return undefined;
      current = current[index];
    } else {
      if (typeof current !== "object") return undefined;
      // Never walk into inherited members — a path shouldn't reach __proto__.
      if (!Object.prototype.hasOwnProperty.call(current, step)) return undefined;
      current = (current as Record<string, unknown>)[step];
    }
  }
  return current;
}
