import { describe, it, expect, afterEach } from "vitest";
import { launchSearch, launchSearchSource , redactSecrets } from "./launch-flags.js";

const g = globalThis as Record<string, unknown>;

/** Stand in for a browser's `location`, which vitest's node env lacks. */
function setUrlSearch(search: string | undefined): void {
  if (search === undefined) { delete g.location; return; }
  g.location = { search } as Location;
}

afterEach(() => {
  delete g.location;
  delete g.__AGENT_FLAGS__;
});

describe("launchSearch", () => {
  it("reads a real query string", () => {
    setUrlSearch("?demo&llm=http://x/v1");
    expect(launchSearch()).toBe("?demo&llm=http://x/v1");
    expect(launchSearchSource()).toBe("url");
  });

  it("falls back to flags baked in at package time", () => {
    // Tizen drops the query from config.xml's <content src>, so this is the
    // only path that works there.
    setUrlSearch("");
    g.__AGENT_FLAGS__ = "demo&confirm=auto";
    expect(launchSearch()).toBe("?demo&confirm=auto");
    expect(launchSearchSource()).toBe("baked");
  });

  it("accepts baked flags with or without the leading ?", () => {
    setUrlSearch("");
    g.__AGENT_FLAGS__ = "?demo";
    expect(launchSearch()).toBe("?demo");
  });

  it("lets a real query string override the baked one", () => {
    // Otherwise you could never repoint a packaged .wgt from the launch command.
    setUrlSearch("?ask=mute");
    g.__AGENT_FLAGS__ = "demo";
    expect(launchSearch()).toBe("?ask=mute");
    expect(launchSearchSource()).toBe("url");
  });

  it("treats a bare ? as no query", () => {
    setUrlSearch("?");
    g.__AGENT_FLAGS__ = "demo";
    expect(launchSearch()).toBe("?demo");
  });

  it("reports nothing when neither source has anything", () => {
    setUrlSearch("");
    expect(launchSearch()).toBe("");
    expect(launchSearchSource()).toBe("none");
  });

  it("survives a non-string or absent global", () => {
    setUrlSearch("");
    g.__AGENT_FLAGS__ = 42;
    expect(launchSearch()).toBe("");
    g.__AGENT_FLAGS__ = "   ";
    expect(launchSearch()).toBe("");
  });

  it("works with no location at all (node, tests, a worker)", () => {
    setUrlSearch(undefined);
    g.__AGENT_FLAGS__ = "diag";
    expect(launchSearch()).toBe("?diag");
  });
});

describe("redactSecrets", () => {
  it("masks an API key, because the debug line puts this on a television", () => {
    // The `?debug` status line printed the query verbatim. On a shipped TV that
    // key is the same for every unit of the model — one screenshot and it's gone.
    expect(redactSecrets("?llm=https://api.example/v1&key=sk-live-abc123"))
      .toBe("?llm=https://api.example/v1&key=***");
  });

  it("leaves everything else exactly as it was", () => {
    // It is a debugging aid: reordering or re-encoding the rest would make it
    // stop matching what was actually passed in, which is the whole point of it.
    const flags = "?render=avatar&keyboard=phrases&ask=set%20volume%20to%2030&debug";
    expect(redactSecrets(flags)).toBe(flags);
  });

  it("masks the first parameter too, with or without a leading ?", () => {
    expect(redactSecrets("?key=sk-1&llm=x")).toBe("?key=***&llm=x");
    expect(redactSecrets("key=sk-1&llm=x")).toBe("key=***&llm=x");
  });

  it("covers the other names a credential tends to arrive under", () => {
    for (const name of ["token", "secret", "password", "api_key", "apiKey", "auth"]) {
      expect(redactSecrets(`?${name}=hunter2`), name).toBe(`?${name}=***`);
    }
  });

  it("is case-insensitive, so ?KEY= isn't a way around it", () => {
    expect(redactSecrets("?KEY=sk-1")).toBe("?KEY=***");
  });

  it("doesn't mask a parameter that merely contains a secret-ish word", () => {
    // `keyboard` starts with "key". Masking it would hide a real flag and make
    // the line useless for the thing it exists for.
    expect(redactSecrets("?keyboard=phrases")).toBe("?keyboard=phrases");
    expect(redactSecrets("?monkey=1")).toBe("?monkey=1");
  });

  it("leaves an empty value alone rather than inventing a secret", () => {
    expect(redactSecrets("?key=&llm=x")).toBe("?key=&llm=x");
  });

  it("survives a malformed escape instead of throwing mid-render", () => {
    // decodeURIComponent throws on a lone %; the status line must still render.
    expect(() => redactSecrets("?%=1&key=sk-1")).not.toThrow();
    expect(redactSecrets("?%=1&key=sk-1")).toContain("key=***");
  });

  it("handles nothing at all", () => {
    expect(redactSecrets("")).toBe("");
  });
});
