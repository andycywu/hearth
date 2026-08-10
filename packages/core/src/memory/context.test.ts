import { describe, it, expect } from "vitest";
import { ConversationContext } from "./context.js";
import type { ChatMessage } from "../llm/client.js";

describe("ConversationContext", () => {
  it("always prepends the system prompt", () => {
    const ctx = new ConversationContext("SYS");
    ctx.add({ role: "user", content: "hi" });
    const msgs = ctx.toMessages();
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  it("trims to the most recent maxTurns", () => {
    const ctx = new ConversationContext("SYS", 3);
    for (let i = 0; i < 10; i++) ctx.add({ role: "user", content: `m${i}` });
    expect(ctx.length).toBe(3);
    const body = ctx.toMessages().slice(1).map((m) => m.content);
    expect(body).toEqual(["m7", "m8", "m9"]);
    // system prompt survives trimming
    expect(ctx.toMessages()[0].content).toBe("SYS");
  });

  it("reset clears history but keeps the system prompt", () => {
    const ctx = new ConversationContext("SYS");
    ctx.add({ role: "user", content: "hi" });
    ctx.reset();
    expect(ctx.length).toBe(0);
    expect(ctx.toMessages()).toEqual([{ role: "system", content: "SYS" }]);
  });
});

describe("trimming must not orphan a tool result", () => {
  /**
   * The trim cuts at a message count, not at a turn boundary, so it can drop an
   * assistant's `tool_calls` while keeping the `tool` message that answered it.
   * Every OpenAI-compatible server rejects that shape outright — and not just
   * for one turn: the orphan stays in history, so every following request 400s
   * too.
   *
   * Never seen offline, because the scripted client ignores history entirely.
   * Found by walking real turn shapes: plain turns, one-tool turns, and the
   * two-tool turn that "open Netflix" produces (search then launch).
   */
  const orphans = (msgs: ChatMessage[]): string[] => {
    const offered = new Set<string>();
    const bad: string[] = [];
    for (const m of msgs) {
      for (const tc of m.toolCalls ?? []) offered.add(tc.id);
      if (m.role === "tool" && m.toolCallId && !offered.has(m.toolCallId)) bad.push(m.toolCallId);
    }
    return bad;
  };

  /** One turn, with `toolCount` tool calls in it. */
  const turn = (ctx: ConversationContext, id: string, toolCount: number): void => {
    ctx.add({ role: "user", content: "q" });
    for (let k = 0; k < toolCount; k++) {
      ctx.add({ role: "assistant", content: "", toolCalls: [{ id: `${id}-${k}`, name: "get_volume", args: {} }] });
      ctx.add({ role: "tool", toolCallId: `${id}-${k}`, content: "{}" });
    }
    ctx.add({ role: "assistant", content: "a" });
  };

  it("survives the exact sequence that used to break it", () => {
    // Four plain turns, two single-tool turns, then an "open Netflix".
    const ctx = new ConversationContext("sys", 12);
    [0, 0, 0, 0, 1, 1, 2].forEach((n, i) => turn(ctx, `t${i}`, n));
    expect(orphans(ctx.toMessages())).toEqual([]);
  });

  it("survives every mix of turn shapes, not just that one", () => {
    for (const shapes of [[1, 0, 2, 1, 0, 2, 1], [2, 2, 2, 2], [0, 1, 0, 1, 0, 1, 0, 1], [1, 2, 0, 0, 1, 2]]) {
      const ctx = new ConversationContext("sys", 12);
      shapes.forEach((n, i) => turn(ctx, `t${i}`, n));
      expect(orphans(ctx.toMessages()), shapes.join(",")).toEqual([]);
    }
  });

  it("applies the same rule to a restored conversation", () => {
    // restore() replays through add(), so a snapshot saved before the fix — or
    // one trimmed at a different cap — must come back clean too.
    const ctx = new ConversationContext("sys", 12);
    ctx.restore([
      { role: "tool", toolCallId: "gone", content: "{}" },
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    expect(orphans(ctx.toMessages())).toEqual([]);
  });
});
