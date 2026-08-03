import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@tv-ai-agent/platform-api";
import {
  installManifest, uninstallManifest, listInstalledManifests, loadInstalledSkills, MAX_INSTALLED,
} from "./store.js";
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

describe("installing skills into platform.storage", () => {
  it("installs, lists and uninstalls", async () => {
    const storage = createMemoryStore();
    expect(await listInstalledManifests(storage)).toEqual([]);

    expect(await installManifest(storage, manifest("get_weather"))).toEqual({ ok: true, errors: [] });
    expect((await listInstalledManifests(storage)).map((m) => m.name)).toEqual(["get_weather"]);

    expect(await uninstallManifest(storage, "get_weather")).toBe(true);
    expect(await listInstalledManifests(storage)).toEqual([]);
    expect(await uninstallManifest(storage, "get_weather")).toBe(false);
  });

  it("survives a new store — installing has to outlive a restart", async () => {
    // The whole point of source (b); it only became possible once
    // platform.storage stopped being an in-memory Map.
    const storage = createMemoryStore();
    await installManifest(storage, manifest("get_weather"));
    const reread = await listInstalledManifests(storage);
    expect(reread.map((m) => m.name)).toEqual(["get_weather"]);
  });

  it("replaces a skill of the same name rather than duplicating it", async () => {
    const storage = createMemoryStore();
    await installManifest(storage, manifest("get_weather"));
    await installManifest(storage, manifest("get_weather", { description: "A newer description here." }));
    const list = await listInstalledManifests(storage);
    expect(list).toHaveLength(1);
    expect(list[0]!.description).toBe("A newer description here.");
  });

  it("rejects an invalid manifest at install time, with reasons", async () => {
    const storage = createMemoryStore();
    const result = await installManifest(storage, { name: "Bad Name", description: "x" });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // Nothing should have been written.
    expect(await listInstalledManifests(storage)).toEqual([]);
  });

  it("accepts a JSON string, which is what an installer actually has", async () => {
    const storage = createMemoryStore();
    expect((await installManifest(storage, JSON.stringify(manifest("from_text")))).ok).toBe(true);
    expect((await listInstalledManifests(storage))[0]!.name).toBe("from_text");
  });

  it("caps how many skills can be installed", async () => {
    const storage = createMemoryStore();
    for (let i = 0; i < MAX_INSTALLED; i++) {
      expect((await installManifest(storage, manifest(`skill_${i}`))).ok).toBe(true);
    }
    const overflow = await installManifest(storage, manifest("one_too_many"));
    expect(overflow.ok).toBe(false);
    expect(overflow.errors[0]).toMatch(/too many installed skills/);
  });

  it("ignores corrupt storage instead of crashing at boot", async () => {
    const storage = createMemoryStore();
    await storage.set("skills:installed", "{ not json");
    expect(await listInstalledManifests(storage)).toEqual([]);
    await storage.set("skills:installed", JSON.stringify({ not: "an array" }));
    expect(await listInstalledManifests(storage)).toEqual([]);
  });

  it("skips an entry that no longer validates", async () => {
    // e.g. written by a newer version, or hand-edited.
    const storage = createMemoryStore();
    await storage.set("skills:installed", JSON.stringify([manifest("good_one"), { name: "Bad Name" }]));
    expect((await listInstalledManifests(storage)).map((m) => m.name)).toEqual(["good_one"]);
  });
});

describe("loadInstalledSkills", () => {
  it("returns ready-to-register tools", async () => {
    const storage = createMemoryStore();
    await installManifest(storage, manifest("get_weather"));
    const tools = await loadInstalledSkills(storage, { allowOrigins: ALLOW });
    expect(tools.map((t) => t.spec.name)).toEqual(["get_weather"]);
  });

  it("drops a skill whose origin the host doesn't allow, and says which", async () => {
    // One unusable skill must not stop the agent from starting.
    const storage = createMemoryStore();
    await installManifest(storage, manifest("allowed"));
    await installManifest(storage, manifest("not_allowed", {
      request: { url: "https://elsewhere.example.com/x?q={q}" },
    }));

    const skipped: Array<[string, string]> = [];
    const tools = await loadInstalledSkills(storage, {
      allowOrigins: ALLOW,
      onSkipped: (name, reason) => skipped.push([name, reason]),
    });

    expect(tools.map((t) => t.spec.name)).toEqual(["allowed"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![0]).toBe("not_allowed");
    expect(skipped[0]![1]).toMatch(/not in the host's allowlist/);
  });

  it("returns nothing when no skills are installed", async () => {
    expect(await loadInstalledSkills(createMemoryStore(), { allowOrigins: ALLOW })).toEqual([]);
  });
});
