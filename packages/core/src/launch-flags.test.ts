import { describe, it, expect, afterEach } from "vitest";
import { launchSearch, launchSearchSource } from "./launch-flags.js";

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
