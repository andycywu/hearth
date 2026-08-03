import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadBundledSkills } from "./bundled.js";
import { validateManifest } from "./schema.js";
import type { SkillManifest } from "./schema.js";

const ALLOW = ["https://api.example.com"];

const manifest = (name: string, over: Partial<SkillManifest> = {}): SkillManifest => ({
  name,
  description: `Does the ${name} thing for the user.`,
  parameters: { q: { type: "string", description: "query", required: true } },
  request: { url: "https://api.example.com/x?q={q}" },
  response: { answer: "result.value" },
  ...over,
});

describe("loadBundledSkills", () => {
  it("turns bundled manifests into tools", async () => {
    const tools = await loadBundledSkills([manifest("a_skill"), manifest("b_skill")], { allowOrigins: ALLOW });
    expect(tools.map((t) => t.spec.name)).toEqual(["a_skill", "b_skill"]);
  });

  it("validates bundled manifests too, and says which one failed", async () => {
    // Shipping it in the bundle earns trust, not an exemption from checking.
    const skipped: string[] = [];
    const tools = await loadBundledSkills(
      [manifest("good_one"), { name: "Bad Name" }],
      { allowOrigins: ALLOW, onSkipped: (name, reason) => skipped.push(`${name}: ${reason}`) },
    );
    expect(tools.map((t) => t.spec.name)).toEqual(["good_one"]);
    expect(skipped[0]).toMatch(/bundled skill #1: .*name/);
  });

  it("keeps the first of two skills sharing a name", async () => {
    const skipped: string[] = [];
    const tools = await loadBundledSkills(
      [manifest("twice"), manifest("twice", { description: "The later one, ignored." })],
      { allowOrigins: ALLOW, onSkipped: (name, reason) => skipped.push(`${name}: ${reason}`) },
    );
    expect(tools).toHaveLength(1);
    expect(skipped[0]).toMatch(/already loaded/);
  });

  it("accepts JSON text, which is what an imported file gives you", async () => {
    const tools = await loadBundledSkills([JSON.stringify(manifest("from_text"))], { allowOrigins: ALLOW });
    expect(tools.map((t) => t.spec.name)).toEqual(["from_text"]);
  });
});

describe("the shipped example", () => {
  it("is a valid manifest", () => {
    // The example is documentation; a broken one teaches the wrong format.
    const text = readFileSync(new URL("../examples/open-meteo-weather.json", import.meta.url), "utf8");
    const result = validateManifest(JSON.parse(text));
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it("loads against the origin a host would allow for it", async () => {
    const text = readFileSync(new URL("../examples/open-meteo-weather.json", import.meta.url), "utf8");
    const tools = await loadBundledSkills([text], { allowOrigins: ["https://api.open-meteo.com"] });
    expect(tools[0]!.spec.name).toBe("get_current_weather");
  });
});
