import type { ToolParameter } from "@hearthkit/core";

/**
 * A skill expressed as data — see docs/adr/0002-declarative-skill-manifests.md.
 * One tool: a schema the model reads, one HTTP request, and a mapping that
 * reduces the response to something small enough to put back in a prompt.
 */
export interface SkillManifest {
  /** Tool name the model calls. snake_case. */
  name: string;
  /** When the assistant should use this. The model chooses on this text. */
  description: string;
  parameters: Record<string, ToolParameter>;
  /** Ask the host before running. Forced true for anything but GET. */
  confirm?: boolean;
  request: ManifestRequest;
  /** Output field → dot/bracket path into the response JSON. */
  response: Record<string, string>;
}

export interface ManifestRequest {
  /** `{param}` placeholders are filled from validated arguments only. */
  url: string;
  method?: "GET" | "POST";
  /** POST only. String values may contain `{param}` placeholders. */
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

/** Caps, so a malformed or hostile manifest can't exhaust the device. */
export const LIMITS = {
  manifestBytes: 16 * 1024,
  parameters: 12,
  responseFields: 24,
  responseBytes: 512 * 1024,
  timeoutMs: 30_000,
} as const;

const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
/** `a.b`, `a[0].b` — paths only. Anything else would need an evaluator. */
const PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[\d+\])*$/;
const PLACEHOLDER = /\{([^}]*)\}/g;

const PARAM_TYPES = new Set(["string", "number", "boolean"]);
const MANIFEST_KEYS = new Set(["name", "description", "parameters", "confirm", "request", "response", "$schema"]);
const REQUEST_KEYS = new Set(["url", "method", "body", "timeoutMs"]);
const PARAM_KEYS = new Set(["type", "description", "required", "enum"]);

export type ValidationResult =
  | { ok: true; manifest: SkillManifest }
  | { ok: false; errors: string[] };

/**
 * Validate a parsed manifest. Strict on purpose: an unknown field is an error
 * rather than something ignored, so a typo can't quietly disable a guardrail.
 * Returns every problem at once so an installer can show them all.
 */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (m: string): void => { errors.push(m); };

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  const m = input as Record<string, unknown>;

  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(key)) fail(`unknown field "${key}"`);
  }

  if (typeof m.name !== "string" || !NAME.test(m.name)) {
    fail('"name" must be snake_case, 2-64 chars, starting with a letter');
  }
  if (typeof m.description !== "string" || m.description.trim().length < 8) {
    fail('"description" must be a sentence the model can choose on (8+ chars)');
  }

  // --- parameters ---
  const params = m.parameters;
  const paramNames: string[] = [];
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail('"parameters" must be an object (use {} for none)');
  } else {
    const entries = Object.entries(params as Record<string, unknown>);
    if (entries.length > LIMITS.parameters) {
      fail(`too many parameters (${entries.length} > ${LIMITS.parameters})`);
    }
    for (const [key, raw] of entries) {
      if (!PARAM_NAME.test(key)) { fail(`parameter "${key}" has an unusable name`); continue; }
      paramNames.push(key);
      if (typeof raw !== "object" || raw === null) { fail(`parameter "${key}" must be an object`); continue; }
      const p = raw as Record<string, unknown>;
      for (const k of Object.keys(p)) {
        if (!PARAM_KEYS.has(k)) fail(`parameter "${key}" has unknown field "${k}"`);
      }
      // object/array parameters can't be interpolated into a URL, so they're out.
      if (typeof p.type !== "string" || !PARAM_TYPES.has(p.type)) {
        fail(`parameter "${key}" needs a type of string, number or boolean`);
      }
      if (typeof p.description !== "string" || !p.description.trim()) {
        fail(`parameter "${key}" needs a description — the model fills it in from that`);
      }
      if (p.required !== undefined && typeof p.required !== "boolean") {
        fail(`parameter "${key}": "required" must be a boolean`);
      }
      if (p.enum !== undefined && (!Array.isArray(p.enum) || p.enum.some((v) => typeof v !== "string"))) {
        fail(`parameter "${key}": "enum" must be an array of strings`);
      }
    }
  }

  // --- request ---
  const req = m.request;
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    fail('"request" must be an object');
  } else {
    const r = req as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      if (!REQUEST_KEYS.has(k)) fail(`request has unknown field "${k}"`);
    }
    if (typeof r.url !== "string" || !r.url.trim()) {
      fail('request.url is required');
    } else {
      for (const name of placeholdersIn(r.url)) {
        if (!paramNames.includes(name)) fail(`request.url uses {${name}}, which is not a declared parameter`);
      }
      // The scheme has to be checkable without knowing the arguments.
      const scheme = r.url.split(":")[0]?.toLowerCase();
      if (scheme !== "https" && scheme !== "http") fail("request.url must be http or https");
      // ...and so does the host: an allowlist is worthless if an argument can
      // decide who the request goes to.
      const authority = r.url.slice(`${scheme}://`.length).split(/[/?#]/)[0] ?? "";
      if (placeholdersIn(authority).length) {
        fail("request.url may not put a placeholder in the host — the origin has to be fixed");
      }
    }
    if (r.method !== undefined && r.method !== "GET" && r.method !== "POST") {
      fail('request.method must be "GET" or "POST"');
    }
    if (r.body !== undefined) {
      if (r.method !== "POST") fail("request.body is only allowed with POST");
      if (typeof r.body !== "object" || r.body === null || Array.isArray(r.body)) {
        fail("request.body must be an object");
      } else {
        // Walk the values: stringifying first would let the placeholder regex
        // match across the JSON's own braces (`{"q":"{city}`).
        for (const value of stringValuesIn(r.body)) {
          for (const name of placeholdersIn(value)) {
            if (!paramNames.includes(name)) fail(`request.body uses {${name}}, which is not a declared parameter`);
          }
        }
      }
    }
    if (r.timeoutMs !== undefined) {
      if (typeof r.timeoutMs !== "number" || !Number.isFinite(r.timeoutMs) || r.timeoutMs <= 0) {
        fail("request.timeoutMs must be a positive number");
      } else if (r.timeoutMs > LIMITS.timeoutMs) {
        fail(`request.timeoutMs must be ≤ ${LIMITS.timeoutMs}`);
      }
    }
  }

  // --- response mapping ---
  const res = m.response;
  if (typeof res !== "object" || res === null || Array.isArray(res)) {
    fail('"response" must be an object mapping output fields to paths');
  } else {
    const entries = Object.entries(res as Record<string, unknown>);
    if (entries.length === 0) fail('"response" must map at least one field');
    if (entries.length > LIMITS.responseFields) {
      fail(`too many response fields (${entries.length} > ${LIMITS.responseFields})`);
    }
    for (const [key, path] of entries) {
      if (!PARAM_NAME.test(key)) fail(`response field "${key}" has an unusable name`);
      if (typeof path !== "string" || !PATH.test(path)) {
        fail(`response.${key} must be a path like "current.temp" or "results[0].name"`);
      }
    }
  }

  if (m.confirm !== undefined && typeof m.confirm !== "boolean") fail('"confirm" must be a boolean');

  return errors.length ? { ok: false, errors } : { ok: true, manifest: input as SkillManifest };
}

/** Parse and validate, with a size cap — for anything arriving as text. */
export function parseManifest(text: string): ValidationResult {
  if (text.length > LIMITS.manifestBytes) {
    return { ok: false, errors: [`manifest is too large (> ${LIMITS.manifestBytes} bytes)`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`not valid JSON: ${(err as Error).message}`] };
  }
  return validateManifest(parsed);
}

/** Placeholder names used in a template string. */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!.trim());
}

/** Every string value inside a JSON-ish structure, at any depth. */
export function stringValuesIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValuesIn);
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(stringValuesIn);
  }
  return [];
}
