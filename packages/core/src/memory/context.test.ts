import { describe, it, expect } from "vitest";
import { ConversationContext } from "./context.js";

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
