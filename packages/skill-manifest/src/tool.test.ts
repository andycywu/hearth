import { describe, it, expect } from "vitest";
import { createManifestTool, readPath } from "./tool.js";
import type { SkillManifest } from "./schema.js";

const ALLOW = ["https://api.example.com"];

const manifest = (over: Partial<SkillManifest> = {}): SkillManifest => ({
  name: "get_weather",
  description: "Current weather for a city.",
  parameters: { city: { type: "string", description: "City name", required: true } },
  request: { url: "https://api.example.com/w?q={city}" },
  response: { tempC: "current.temp", summary: "current.text" },
  ...over,
});

/** Records requests, replies from a script. */
function fakeFetch(replies: Array<{ ok?: boolean; status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    const next = replies.shift() ?? { ok: false, status: 500 };
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => next.text ?? JSON.stringify(next.body ?? {}),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("createManifestTool", () => {
  it("builds a tool from the manifest's schema", () => {
    const tool = createManifestTool(manifest(), { allowOrigins: ALLOW });
    expect(tool.spec.name).toBe("get_weather");
    expect(tool.spec.description).toBe("Current weather for a city.");
    expect(tool.spec.parameters.city?.required).toBe(true);
  });

  it("fills the URL from validated arguments and maps the response", async () => {
    const { impl, calls } = fakeFetch([{ body: { current: { temp: 21.5, text: "Cloudy" } } }]);
    const tool = createManifestTool(manifest(), { allowOrigins: ALLOW, fetchImpl: impl });
    expect(await tool.execute({ city: "Taipei" })).toEqual({ tempC: 21.5, summary: "Cloudy" });
    expect(calls[0]!.url).toBe("https://api.example.com/w?q=Taipei");
  });

  it("percent-encodes interpolated values", async () => {
    const { impl, calls } = fakeFetch([{ body: { current: { temp: 1, text: "x" } } }]);
    await createManifestTool(manifest(), { allowOrigins: ALLOW, fetchImpl: impl })
      .execute({ city: "New York&x=1" });
    expect(calls[0]!.url).toBe(`https://api.example.com/w?q=${encodeURIComponent("New York&x=1")}`);
  });

  it("omits response fields the service didn't return", async () => {
    const { impl } = fakeFetch([{ body: { current: { temp: 3 } } }]);
    const out = await createManifestTool(manifest(), { allowOrigins: ALLOW, fetchImpl: impl })
      .execute({ city: "x" });
    expect(out).toEqual({ tempC: 3 });
  });

  // --- the guardrails from ADR-0002 ---

  it("refuses an origin the host didn't allow, at construction", () => {
    // The manifest's host is fixed, so a host learns at load time rather than
    // discovering it halfway through a conversation.
    expect(() => createManifestTool(
      manifest({ request: { url: "https://evil.example.com/steal?q={city}" } }),
      { allowOrigins: ALLOW },
    )).toThrow(/not in the host's allowlist/);
  });

  it("requires the host to supply an allowlist at all", () => {
    expect(() => createManifestTool(manifest(), { allowOrigins: [] }))
      .toThrow(/allowOrigins is required/);
  });

  it("refuses plain http to a remote host, even if the host allowlisted it", () => {
    expect(() => createManifestTool(
      manifest({ request: { url: "http://api.example.com/w?q={city}" } }),
      { allowOrigins: ["http://api.example.com"] },
    )).toThrow(/refusing plain http/);
  });

  it("allows http to loopback, for a model or service on the TV itself", async () => {
    const { impl, calls } = fakeFetch([{ body: { current: { temp: 9 } } }]);
    const tool = createManifestTool(
      manifest({ request: { url: "http://127.0.0.1:8080/w?q={city}" } }),
      { allowOrigins: ["loopback"], fetchImpl: impl },
    );
    expect(await tool.execute({ city: "x" })).toEqual({ tempC: 9 });
    expect(calls[0]!.url).toContain("127.0.0.1");
  });

  it("never sends headers the manifest asked for — there are none to ask with", async () => {
    const { impl, calls } = fakeFetch([{ body: { current: { temp: 1 } } }]);
    await createManifestTool(manifest(), { allowOrigins: ALLOW, fetchImpl: impl }).execute({ city: "x" });
    expect(calls[0]!.init?.headers).toBeUndefined();
  });

  it("forces confirmation on anything that isn't a GET", () => {
    const post = createManifestTool(
      manifest({ request: { url: "https://api.example.com/set", method: "POST", body: { c: "{city}" } } }),
      { allowOrigins: ALLOW },
    );
    expect(post.spec.confirm).toBe(true);
    // ...and leaves a read alone unless it asked.
    expect(createManifestTool(manifest(), { allowOrigins: ALLOW }).spec.confirm).toBeUndefined();
    expect(createManifestTool(manifest({ confirm: true }), { allowOrigins: ALLOW }).spec.confirm).toBe(true);
  });

  it("only interpolates declared parameters", async () => {
    const { impl, calls } = fakeFetch([{ body: { current: { temp: 1 } } }]);
    const tool = createManifestTool(manifest(), { allowOrigins: ALLOW, fetchImpl: impl });
    // An extra argument the schema never declared must not reach the URL.
    await tool.execute({ city: "x", secret: "hunter2" } as Record<string, unknown>);
    expect(calls[0]!.url).not.toContain("hunter2");
  });

  it("escapes interpolated values inside a POST body", async () => {
    const { impl, calls } = fakeFetch([{ body: { current: { temp: 1 } } }]);
    const tool = createManifestTool(
      manifest({ request: { url: "https://api.example.com/x", method: "POST", body: { q: "{city}" } } }),
      { allowOrigins: ALLOW, fetchImpl: impl },
    );
    await tool.execute({ city: 'a" , "injected": "yes' });
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ q: 'a" , "injected": "yes' });
  });

  it("rejects an invalid manifest at construction, not at call time", () => {
    expect(() => createManifestTool({ ...manifest(), name: "Bad Name" }, { allowOrigins: ALLOW }))
      .toThrow(/invalid skill manifest/);
  });

  // --- failure behaviour ---

  it("reports an HTTP failure in a sentence the model can act on", async () => {
    const { impl } = fakeFetch([{ ok: false, status: 503 }]);
    await expect(createManifestTool(manifest(), { allowOrigins: ALLOW, fetchImpl: impl }).execute({ city: "x" }))
      .rejects.toThrow(/get_weather: the service answered HTTP 503/);
  });

  it("reports a non-JSON response", async () => {
    const { impl } = fakeFetch([{ text: "<html>nope</html>" }]);
    await expect(createManifestTool(manifest(), { allowOrigins: ALLOW, fetchImpl: impl }).execute({ city: "x" }))
      .rejects.toThrow(/didn't return JSON/);
  });

  it("reports a response with none of the expected fields", async () => {
    const { impl } = fakeFetch([{ body: { something: "else" } }]);
    await expect(createManifestTool(manifest(), { allowOrigins: ALLOW, fetchImpl: impl }).execute({ city: "x" }))
      .rejects.toThrow(/none of the fields this skill expects/);
  });

  it("turns a timeout into a readable message", async () => {
    const impl = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const tool = createManifestTool(
      manifest({ request: { url: "https://api.example.com/w?q={city}", timeoutMs: 25 } }),
      { allowOrigins: ALLOW, fetchImpl: impl },
    );
    await expect(tool.execute({ city: "x" })).rejects.toThrow(/no answer within 25ms/);
  });
});

describe("readPath", () => {
  it("walks objects and array indices", () => {
    const data = { a: { b: [{ c: 42 }] } };
    expect(readPath(data, "a.b[0].c")).toBe(42);
    expect(readPath(data, "a.b")).toEqual([{ c: 42 }]);
  });

  it("returns undefined rather than throwing on a missing path", () => {
    expect(readPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(readPath({}, "nope")).toBeUndefined();
    expect(readPath(null, "a")).toBeUndefined();
    expect(readPath({ a: [] }, "a[3]")).toBeUndefined();
  });

  it("won't walk into inherited members", () => {
    // A path must not be able to reach the prototype chain.
    expect(readPath({}, "constructor")).toBeUndefined();
    expect(readPath({}, "__proto__")).toBeUndefined();
    expect(readPath({ a: {} }, "a.constructor.name")).toBeUndefined();
  });
});
