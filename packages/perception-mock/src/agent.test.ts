import { describe, it, expect } from "vitest";
import { Agent, W, type LlmClient, type CompletionResult } from "@tv-ai-agent/core";
import { createWebAdapter } from "@tv-ai-agent/adapter-web";
import { createScriptedSource, occupancyScript } from "./index.js";

/**
 * Perception through the agent, which is where it has to work: one confirmation
 * handler for tools and sensors alike, one world, and the room ending up in the
 * prompt without anybody wiring that up per host.
 */

const silent: LlmClient = {
  id: "silent",
  complete: async (): Promise<CompletionResult> => ({
    wantsToolCalls: false,
    message: { role: "assistant", content: "ok" },
  }),
};

function agentWithCamera(consent: boolean) {
  const asked: string[] = [];
  const agent = new Agent({
    platform: createWebAdapter(),
    llm: silent,
    confirm: (req) => { asked.push(req.name); return consent; },
  });
  const source = createScriptedSource({ script: occupancyScript() });
  agent.perception.register(source);
  return { agent, source, asked };
}

describe("perception, through the agent", () => {
  it("asks with the same handler a gated tool uses", async () => {
    const { agent, source, asked } = agentWithCamera(true);
    const result = await agent.perception.start(source.id);
    expect(result.started).toBe(true);
    // One door where a person says yes, whatever is asking.
    expect(asked).toEqual([`perception:${source.id}`]);
  });

  it("keeps the camera shut when the answer is no", async () => {
    const { agent, source } = agentWithCamera(false);
    expect(await agent.perception.start(source.id)).toMatchObject({ started: false });
    expect(agent.perception.active).toEqual([]);
    expect(agent.world.paths()).toEqual([]);
  });

  it("puts the room in the world, and therefore in the prompt", async () => {
    const { agent, source } = agentWithCamera(true);
    await agent.perception.start(source.id);
    source.tick();
    source.tick();

    expect(agent.world.value(W.roomPeopleCount)).toBe(3);
    // Which is the whole point: the model is told there are three people in the
    // room without anyone teaching the agent loop about cameras.
    expect(agent.world.summarize()).toContain("room.peopleCount: 3");
  });

  it("reports grants and events on the bus a host already listens to", async () => {
    const { agent, source } = agentWithCamera(true);
    const grants: (string | undefined)[] = [];
    const seen: string[] = [];
    agent.events.on("perception:grant", ({ grant, sourceId }) => grants.push(grant ? sourceId : undefined));
    agent.events.on("perception:event", ({ event }) => seen.push(event.type));

    await agent.perception.start(source.id);
    source.tick();
    await agent.perception.revokeAll();

    expect(grants).toEqual([source.id, undefined]);
    expect(seen).toEqual(["occupancy_changed"]);
  });
});
