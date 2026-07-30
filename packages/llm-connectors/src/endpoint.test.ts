import { describe, it, expect } from "vitest";
import { resolveLlmEndpoint } from "./endpoint.js";

describe("resolveLlmEndpoint", () => {
  it("reports nothing configured when there is no query, global or default", () => {
    expect(resolveLlmEndpoint({ search: "", globals: {} })).toEqual({
      model: "local-tv-agent",
      source: "none",
    });
  });

  it("falls back to the caller's defaults", () => {
    expect(resolveLlmEndpoint({
      search: "", globals: {},
      defaultBaseUrl: "http://127.0.0.1:8080/v1", defaultModel: "d",
    })).toEqual({ baseUrl: "http://127.0.0.1:8080/v1", model: "d", source: "default" });
  });

  it("prefers a window global over the default", () => {
    const r = resolveLlmEndpoint({
      search: "",
      globals: { __AGENT_LLM_BASE_URL__: "http://host:1/v1", __AGENT_LLM_MODEL__: "g" },
      defaultBaseUrl: "http://default/v1",
    });
    expect(r).toMatchObject({ baseUrl: "http://host:1/v1", model: "g", source: "global" });
  });

  it("prefers the query string over everything — repoint a shipped bundle, no rebuild", () => {
    const r = resolveLlmEndpoint({
      search: "?diag&llm=http://127.0.0.1:9000/v1&model=llama3.2",
      globals: { __AGENT_LLM_BASE_URL__: "http://host:1/v1", __AGENT_LLM_MODEL__: "g" },
      defaultBaseUrl: "http://default/v1",
    });
    expect(r).toMatchObject({ baseUrl: "http://127.0.0.1:9000/v1", model: "llama3.2", source: "query" });
  });

  it("mixes sources per field", () => {
    // Query gives the endpoint, the global still supplies the model.
    const r = resolveLlmEndpoint({
      search: "?llm=http://q/v1",
      globals: { __AGENT_LLM_MODEL__: "from-global" },
    });
    expect(r).toMatchObject({ baseUrl: "http://q/v1", model: "from-global", source: "query" });
  });

  it("passes an api key through from either source, and omits it otherwise", () => {
    expect(resolveLlmEndpoint({ search: "?key=sk-q", globals: {} }).apiKey).toBe("sk-q");
    expect(resolveLlmEndpoint({ search: "", globals: { __AGENT_LLM_API_KEY__: "sk-g" } }).apiKey).toBe("sk-g");
    expect(resolveLlmEndpoint({ search: "", globals: {} })).not.toHaveProperty("apiKey");
  });

  it("treats blank and non-string values as absent", () => {
    const r = resolveLlmEndpoint({
      search: "?llm=%20&model=",
      globals: { __AGENT_LLM_BASE_URL__: 42, __AGENT_LLM_MODEL__: null },
      defaultBaseUrl: "http://default/v1",
    });
    expect(r).toMatchObject({ baseUrl: "http://default/v1", model: "local-tv-agent", source: "default" });
  });

  it("decodes an encoded endpoint", () => {
    const r = resolveLlmEndpoint({
      search: "?llm=" + encodeURIComponent("http://127.0.0.1:11434/v1"),
      globals: {},
    });
    expect(r.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
});
