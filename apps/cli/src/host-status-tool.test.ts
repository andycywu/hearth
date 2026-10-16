import { describe, expect, it } from "vitest";
import { Agent, type ChatMessage, type CompletionRequest, type CompletionResult, type LlmClient } from "@hearthkit/core";
import { createWebAdapter } from "@hearthkit/adapter-web";
import { hostStatusTool } from "./room.js";

/**
 * "Is the Pi okay?" through the same loop as "what is the volume": the model asks for a tool, this box runs it and
 * reads it back, the model answers from the result. The model here is scripted — what is under test is that the tool
 * reaches it, that its arguments and result make the round trip, and that an unreadable field arrives as null.
 */
const STATUS = { online: true, cpu_temperature_c: 48.2, memory_free_mb: 312, load_1m: 0.4, power: null, unreadable: [] };

function scriptedModel(seen: CompletionRequest[]): LlmClient {
  return {
    id: "scripted",
    async complete(req): Promise<CompletionResult> {
      seen.push(req);
      const result = req.messages.find((m) => m.role === "tool");
      if (!result) {
        const call = { id: "call_1", name: "get_host_status", args: {} };
        return { wantsToolCalls: true, message: { role: "assistant", content: "", toolCalls: [call] } };
      }
      const s = JSON.parse(result.content) as typeof STATUS;
      return { wantsToolCalls: false, message: { role: "assistant", content: `The Pi is online, ${s.cpu_temperature_c} °C, ${s.memory_free_mb} MB free.` } };
    },
  };
}

describe("get_host_status", () => {
  it("is offered to the model, runs here, and its result is what the model answers from", async () => {
    const seen: CompletionRequest[] = [];
    const tool = await hostStatusTool(async () => STATUS);
    const agent = new Agent({ platform: createWebAdapter(), llm: scriptedModel(seen), tools: [tool], confirm: () => true });
    const calls: string[] = [];
    agent.events.on("tool:call", ({ name }) => calls.push(name));

    const reply = await agent.run("how is the Raspberry Pi doing?");
    expect(reply).toBe("The Pi is online, 48.2 °C, 312 MB free.");
    expect(calls).toEqual(["get_host_status"]);
    expect(seen[0]?.tools.map((t) => t.name)).toContain("get_host_status");
    // The call id survives the round trip: the second request carries the result under the id the model issued.
    const second = seen[1]!.messages as ChatMessage[];
    expect(second.find((m) => m.role === "tool")).toMatchObject({ toolCallId: "call_1" });
  });

  it("says what it is for: this box, not the television, and never a guess", async () => {
    const { spec } = await hostStatusTool(async () => STATUS);
    expect(spec.name).toBe("get_host_status");
    expect(spec.description).toMatch(/Raspberry Pi, not the television/);
    expect(spec.description).toMatch(/never guess/);
    expect(spec.parameters).toEqual({});
  });
});
