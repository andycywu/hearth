import { describe, expect, it } from "vitest";
import { Agent, type CompletionRequest, type CompletionResult, type LlmClient } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import type { RingState, StatusRing } from "@hearthkit/adapter-linux";
import { DEFAULT_LED_BRIGHTNESS, ringBrightnessTools } from "./ring-brightness.js";

function fakeRing(start = DEFAULT_LED_BRIGHTNESS / 100): StatusRing & { levels: number[] } {
  let level = start;
  const levels: number[] = [];
  return {
    levels,
    show: async (_s: RingState) => {},
    off: async () => {},
    setLevel: async (l) => { level = l; levels.push(l); },
    level: () => level,
  };
}

/** A model that asks for one tool call, then answers with what came back. */
function asks(name: string, args: Record<string, unknown>, seen: CompletionRequest[] = []): LlmClient {
  return {
    id: "scripted",
    async complete(req): Promise<CompletionResult> {
      seen.push(req);
      const result = req.messages.find((m) => m.role === "tool");
      if (!result) return { wantsToolCalls: true, message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name, args }] } };
      return { wantsToolCalls: false, message: { role: "assistant", content: result.content } };
    },
  };
}

describe("the ring's brightness, by asking", () => {
  it("defaults to 5% of the built-in levels", () => {
    expect(DEFAULT_LED_BRIGHTNESS).toBe(5);
  });

  it("sets it, keeps it for the next start, and says it was written, not read back", async () => {
    const ring = fakeRing();
    const saved: number[] = [];
    const seen: CompletionRequest[] = [];
    const agent = new Agent({
      platform: createWebAdapter(), llm: asks("set_led_brightness", { percent: 25 }, seen),
      tools: ringBrightnessTools(ring, { save: async (p) => { saved.push(p); } }), confirm: () => true,
    });
    const reply = JSON.parse(await agent.run("make your lights a bit brighter")) as Record<string, unknown>;
    expect(ring.levels).toEqual([0.25]);
    expect(saved).toEqual([25]);
    expect(reply).toMatchObject({ brightness_percent: 25, read_back: false, kept_after_restart: true });
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_led_brightness", "set_led_brightness"]));
  });

  it("still dims when the config cannot be written, and says it will not last", async () => {
    const ring = fakeRing();
    const [, set] = ringBrightnessTools(ring, { save: async () => { throw new Error("read-only file system"); } });
    const r = await set!.execute({ percent: 75 });
    expect(ring.levels).toEqual([0.75]);
    expect(r).toMatchObject({ brightness_percent: 75, kept_after_restart: false, why_not_kept: "read-only file system" });
  });

  it("refuses a percent out of range and leaves the ring as it was", async () => {
    const ring = fakeRing();
    const [, set] = ringBrightnessTools(ring, { save: async () => {} });
    await expect(set!.execute({ percent: 0 })).rejects.toThrow(/1 to 100/);
    await expect(set!.execute({ percent: 250 })).rejects.toThrow(/1 to 100/);
    expect(ring.levels).toEqual([]);
  });

  it("reads what was last written", async () => {
    const [get] = ringBrightnessTools(fakeRing(0.1), { save: async () => {} });
    expect(await get!.execute({})).toMatchObject({ brightness_percent: 10, read_back: false });
  });

  it("offers nothing for a ring that cannot be dimmed", () => {
    expect(ringBrightnessTools({ show: async () => {}, off: async () => {} })).toEqual([]);
  });
});
