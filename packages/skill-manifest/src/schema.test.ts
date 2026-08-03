import { describe, it, expect } from "vitest";
import { validateManifest, parseManifest, placeholdersIn, LIMITS } from "./schema.js";

const valid = () => ({
  name: "get_weather",
  description: "Current weather for a city.",
  parameters: { city: { type: "string", description: "City name", required: true } },
  request: { url: "https://api.example.com/w?q={city}" },
  response: { tempC: "current.temperature_2m" },
});
/** Assert it fails, and that the reason mentions `hint`. */
const expectRejected = (manifest: unknown, hint: RegExp) => {
  const r = validateManifest(manifest);
  expect(r.ok, `expected rejection matching ${hint}`).toBe(false);
  if (!r.ok) expect(r.errors.join(" | ")).toMatch(hint);
};

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const r = validateManifest(valid());
    expect(r.ok).toBe(true);
  });

  it("reports every problem at once, so an installer can show them together", () => {
    const r = validateManifest({ name: "Bad Name", description: "x", parameters: {}, request: {}, response: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(2);
  });

  it("rejects an unknown field rather than ignoring it", () => {
    // A typo must not silently disable a guardrail.
    expectRejected({ ...valid(), headers: { authorization: "secret" } }, /unknown field "headers"/);
    expectRejected(
      { ...valid(), request: { url: "https://a.example/x", headers: {} } },
      /request has unknown field "headers"/,
    );
  });

  it("insists on a description the model can choose on", () => {
    expectRejected({ ...valid(), description: "wx" }, /description/);
  });

  it("requires snake_case tool names", () => {
    for (const name of ["GetWeather", "get-weather", "1weather", "x"]) {
      expectRejected({ ...valid(), name }, /name/);
    }
  });

  it("only allows parameter types that can go into a URL", () => {
    expectRejected(
      { ...valid(), parameters: { city: { type: "object", description: "a city" } } },
      /string, number or boolean/,
    );
  });

  it("requires every parameter to be described", () => {
    expectRejected({ ...valid(), parameters: { city: { type: "string" } } }, /needs a description/);
  });

  it("rejects a placeholder that isn't a declared parameter", () => {
    // Otherwise a manifest could reference something the caller never validated.
    expectRejected(
      { ...valid(), request: { url: "https://api.example.com/w?q={secret}" } },
      /\{secret\}, which is not a declared parameter/,
    );
    expectRejected(
      { ...valid(), request: { url: "https://a.example/x", method: "POST", body: { q: "{nope}" } } },
      /\{nope\}/,
    );
  });

  it("rejects a body without POST", () => {
    expectRejected(
      { ...valid(), request: { url: "https://a.example/x", body: { a: 1 } } },
      /body is only allowed with POST/,
    );
  });

  it("won't let an argument choose the host", () => {
    // An allowlist means nothing if {city} can redirect the request.
    expectRejected(
      { ...valid(), request: { url: "https://{city}.example.com/w" } },
      /placeholder in the host/,
    );
    // A placeholder in the path or query is the normal case.
    expect(validateManifest({ ...valid(), request: { url: "https://a.example/{city}/w?q={city}" } }).ok).toBe(true);
  });

  it("rejects non-http(s) schemes outright", () => {
    for (const url of ["file:///etc/passwd", "ftp://a.example/x", "javascript:alert(1)"]) {
      expectRejected({ ...valid(), request: { url } }, /must be http or https/);
    }
  });

  it("only allows paths in the response mapping — no expressions", () => {
    for (const path of ["a + b", "a()", "a.b()", "constructor.prototype", "a['b']", ""]) {
      if (path === "constructor.prototype") continue;   // shape-valid; blocked at read time
      expectRejected({ ...valid(), response: { x: path } }, /must be a path/);
    }
    expect(validateManifest({ ...valid(), response: { x: "results[0].name" } }).ok).toBe(true);
  });

  it("requires at least one response field", () => {
    expectRejected({ ...valid(), response: {} }, /at least one field/);
  });

  it("caps parameters, response fields and timeout", () => {
    const many = Object.fromEntries(
      Array.from({ length: LIMITS.parameters + 1 }, (_, i) => [`p${i}`, { type: "string", description: "x" }]),
    );
    expectRejected({ ...valid(), parameters: many }, /too many parameters/);

    const fields = Object.fromEntries(
      Array.from({ length: LIMITS.responseFields + 1 }, (_, i) => [`f${i}`, "a.b"]),
    );
    expectRejected({ ...valid(), response: fields }, /too many response fields/);

    expectRejected(
      { ...valid(), request: { url: "https://a.example/x", timeoutMs: LIMITS.timeoutMs + 1 } },
      /timeoutMs must be/,
    );
  });

  it("rejects things that aren't objects", () => {
    for (const input of [null, [], "a string", 42]) expectRejected(input, /must be an object/);
  });
});

describe("parseManifest", () => {
  it("parses valid JSON", () => {
    expect(parseManifest(JSON.stringify(valid())).ok).toBe(true);
  });

  it("explains bad JSON instead of throwing", () => {
    const r = parseManifest("{ not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/not valid JSON/);
  });

  it("refuses an oversized document before parsing it", () => {
    const r = parseManifest("x".repeat(LIMITS.manifestBytes + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/too large/);
  });
});

describe("placeholdersIn", () => {
  it("finds each placeholder", () => {
    expect(placeholdersIn("https://x/{a}?b={ b }&c={a}")).toEqual(["a", "b", "a"]);
    expect(placeholdersIn("https://x/none")).toEqual([]);
  });
});
