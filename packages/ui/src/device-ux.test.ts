import { describe, it, expect, afterEach } from "vitest";
import { EventBus, type AgentEvents } from "@tv-ai-agent/core";
import type { Agent, ConfirmRequest } from "@tv-ai-agent/core";
import type { PlatformProvider, VoicePipeline } from "@tv-ai-agent/platform-api";
import { createConfirmHandler, speakReplies } from "./device-ux.js";

const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  name: "set_input_source",
  args: { source: "hdmi2" },
  description: "Switch the active input source.",
  ...over,
});

function fakeAgent(): { agent: Agent; events: EventBus<AgentEvents> } {
  const events = new EventBus<AgentEvents>();
  return { agent: { events } as unknown as Agent, events };
}

/** A platform whose voice slot may be missing, like a device without TTS. */
function platformWithVoice(voice?: Partial<VoicePipeline>): PlatformProvider {
  const provider = {
    voice: voice as VoicePipeline | undefined,
    has: (cap: string) => cap in provider && (provider as any)[cap] !== undefined,
  };
  return provider as unknown as PlatformProvider;
}

describe("createConfirmHandler", () => {
  it("asks the supplied prompt and returns the answer", async () => {
    const asked: string[] = [];
    const allow = createConfirmHandler({ ask: (q) => { asked.push(q); return true; } });
    expect(await allow(request())).toBe(true);
    expect(asked).toEqual(["Allow set_input_source(source=hdmi2)?"]);

    const deny = createConfirmHandler({ ask: () => false });
    expect(await deny(request())).toBe(false);
  });

  it("awaits an async dialog", async () => {
    const handler = createConfirmHandler({ ask: async () => true });
    await expect(Promise.resolve(handler(request()))).resolves.toBe(true);
  });

  it("renders every argument in the question", async () => {
    let question = "";
    const handler = createConfirmHandler({ ask: (q) => { question = q; return true; } });
    await handler(request({ name: "launch_app", args: { appId: "netflix", cold: true } }));
    expect(question).toBe("Allow launch_app(appId=netflix, cold=true)?");
  });

  it("approves by default when no dialog is available", async () => {
    // Node/CI and engines that stub out window.confirm: a turn must not stall on
    // a dialog nobody can see.
    expect(typeof window).toBe("undefined");
    expect(await createConfirmHandler()(request())).toBe(true);
  });

  it("can be configured to deny instead", async () => {
    expect(await createConfirmHandler({ fallback: false })(request())).toBe(false);
  });

  it("uses window.confirm when the engine provides one", async () => {
    const seen: string[] = [];
    (globalThis as any).window = { confirm: (q: string) => { seen.push(q); return false; } };
    try {
      expect(await createConfirmHandler()(request())).toBe(false);
      expect(seen).toHaveLength(1);
    } finally {
      delete (globalThis as any).window;
    }
  });
});

describe("speakReplies", () => {
  afterEach(() => { delete (globalThis as any).window; });

  it("speaks the final output of every turn", () => {
    const spoken: string[] = [];
    const { agent, events } = fakeAgent();
    speakReplies(agent, platformWithVoice({ speak: async (t) => { spoken.push(t); } }));
    events.emit("turn:end", { output: "Volume set to 30." });
    events.emit("turn:end", { output: "音量已設為 30。" });
    expect(spoken).toEqual(["Volume set to 30.", "音量已設為 30。"]);
  });

  it("does nothing on a device without voice", () => {
    const { agent, events } = fakeAgent();
    const off = speakReplies(agent, platformWithVoice(undefined));
    expect(() => { events.emit("turn:end", { output: "hi" }); off(); }).not.toThrow();
  });

  it("stops speaking once unsubscribed", () => {
    const spoken: string[] = [];
    const { agent, events } = fakeAgent();
    const off = speakReplies(agent, platformWithVoice({ speak: async (t) => { spoken.push(t); } }));
    events.emit("turn:end", { output: "first" });
    off();
    events.emit("turn:end", { output: "second" });
    expect(spoken).toEqual(["first"]);
  });

  it("swallows a TTS failure so it can't break the turn", () => {
    const { agent, events } = fakeAgent();
    speakReplies(agent, platformWithVoice({ speak: async () => { throw new Error("no tts engine"); } }));
    expect(() => events.emit("turn:end", { output: "hi" })).not.toThrow();
  });

  it("survives an engine whose speak throws synchronously", () => {
    const { agent, events } = fakeAgent();
    const voice = { speak: (() => { throw new Error("boom"); }) as unknown as VoicePipeline["speak"] };
    speakReplies(agent, platformWithVoice(voice));
    expect(() => events.emit("turn:end", { output: "hi" })).not.toThrow();
  });
});
